import type { Context } from 'hono';
import { backendCooldownManager } from '../../BackendCooldownManager';
import { rateLimitManager } from '../../RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { isDebugEnabled, redactForLog } from '@/utils/debug';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { codeInterpreterManager } from '../../CodeInterpreterManager';
import {
    buildCodeInterpreterToolDefinition,
    normalizeToolChoice,
    runCodeInterpreterToolLoop,
    stripCodeInterpreterTools,
    isCodeInterpreterTool,
    type CodeInterpreterToolRun,
} from '../../codeInterpreterFlow';
import {
    getBackendsForModel,
    getOptimizedBackends,
    getCandidateModelsForProvider,
    isGeminiProvider,
} from '../routing';
import {
    buildApiUrl,
    buildHeaders,
    calculateTokenCount,
    collectTokenStrings,
    ensureToolCallThoughtSignatures,
    parseResponsePayload,
    getEffectiveRateLimit,
    attachUsageIfMissing,
} from '../helpers';
import { withReasoningEffort } from '../reasoning';
import type { BackendState, OpenAIModelConfig } from '../types';

export function shouldUseOpenAICodeInterpreter( body: any ): boolean {
    if ( !codeInterpreterManager.isEnabled() ) return false;
    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    return tools.some( ( tool: any ) => isCodeInterpreterTool( tool ) );
}

export async function proxyCodeInterpreterRequest( c: Context, state: BackendState, endpoint: string, rawBody: any ): Promise<any> {
    const body = rawBody;
    const modelName = body.model;
    let lastFailure: { status: number; payload: any } | null = null;

    if ( body.stream === true ) {
        return c.json( { error: { message: 'code_interpreter does not currently support streaming responses', type: 'invalid_request_error' } }, 400 );
    }

    if ( !modelName || typeof modelName !== 'string' ) {
        return c.json( { error: { message: 'Model is required and must be a string', type: 'invalid_request_error' } }, 400 );
    }

    const matchingBackends = getBackendsForModel( state, modelName, endpoint );
    if ( !matchingBackends.length ) {
        console.error( `[${endpoint}] No backends found for model: ${modelName}` );
        return c.json( { error: { message: `Model not found: ${modelName}`, type: 'invalid_request_error' } }, 400 );
    }

    const backends = getOptimizedBackends( state, modelName, endpoint, matchingBackends );
    console.error( `[${endpoint}] Attempting code interpreter backends for model ${modelName}: ${backends.map( b => b.id ).join( ', ' )}` );

    for ( const config of backends ) {
        const candidateModels = getCandidateModelsForProvider( state, config, modelName );

        for ( const selectedModel of candidateModels ) {
            const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
            if ( cooldownRemainingMs > 0 ) {
                console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                continue;
            }

            try {
                const { payload } = await runCodeInterpreterFlow( c, state, config, body, endpoint, selectedModel );
                const enrichedPayload = attachUsageIfMissing( endpoint, body, payload );
                return c.json( enrichedPayload, 200 );
            } catch ( error: any ) {
                if ( error?.rateLimitExceeded ) continue;

                lastFailure = {
                    status: error?.status ?? 502,
                    payload: error?.payload ?? { error: { message: error?.message || 'Upstream request failed', type: 'upstream_error' } },
                };
                console.error( `[${endpoint}] Code interpreter error from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                continue;
            }
        }
    }

    if ( lastFailure ) {
        const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
        console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
        if ( lastFailure.payload && typeof lastFailure.payload === 'object' ) return c.json( lastFailure.payload, lastFailure.status as any );
        return c.text( String( lastFailure.payload ?? 'Upstream request failed' ), lastFailure.status as any );
    }

    console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED - No response from any backend\nModel: ${modelName}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
    return c.json( { error: { message: 'All providers failed', type: 'internal_error' } }, 502 );
}

async function runCodeInterpreterFlow(
    c: Context,
    state: BackendState,
    config: OpenAIModelConfig,
    body: any,
    endpoint: string,
    selectedModel: string,
): Promise<{ payload: any }> {
    const { request: chatRequest, responseMode } = normalizeCodeInterpreterRequest( body, endpoint, selectedModel );
    const chatRequestWithReasoning = ensureToolCallThoughtSignatures(
        withReasoningEffort( chatRequest, config, selectedModel )
    );
    const { tools } = stripCodeInterpreterTools( chatRequestWithReasoning.tools );
    const toolDefinition = buildCodeInterpreterToolDefinition();
    const toolChoice = normalizeToolChoice( body.tool_choice );
    const rateLimit = getEffectiveRateLimit( config );
    const upstreamEndpoint = 'chat/completions';
    const sessionId = resolveCodeInterpreterSessionId( body );

    const callModel = async ( request: any ) => {
        const url = buildApiUrl( config, upstreamEndpoint );
        if ( isDebugEnabled() ) {
            console.info( `[${upstreamEndpoint}] upstream_request model=${request?.model ?? selectedModel} body=${JSON.stringify( redactForLog( request ) )}` );
        }
        const response = await fetchWithProxy( url, {
            method: 'POST',
            headers: buildHeaders( config ),
            body: JSON.stringify( request ),
        }, CONFIG.proxy );
        const payload = await parseResponsePayload( response );
        if ( isDebugEnabled() ) {
            console.info( `[${upstreamEndpoint}] upstream_response model=${request?.model ?? selectedModel} status=${response.status} body=${JSON.stringify( redactForLog( payload ) )}` );
        }

        if ( !response.ok ) {
            const cooldownModel = typeof request?.model === 'string' ? request.model : selectedModel;
            backendCooldownManager.markFromStatus( config.id, cooldownModel, response.status );
            const error = new Error( `Upstream request failed with ${response.status}` );
            ( error as any ).status = response.status;
            ( error as any ).payload = payload;
            throw error;
        }
        return { response, payload };
    };

    const onBeforeRequest = async ( request: any ) => {
        const tokens = calculateTokenCount( request );
        const rateCheck = await rateLimitManager.checkAndConsume( config.id, tokens, rateLimit, selectedModel );
        if ( !rateCheck.allowed ) {
            const error = new Error( 'Rate limit exceeded' );
            ( error as any ).rateLimitExceeded = true;
            throw error;
        }
    };

    const { payload, toolRuns } = await runCodeInterpreterToolLoop( {
        request: { ...chatRequestWithReasoning, tools },
        toolDefinition, toolChoice, callModel, onBeforeRequest,
        executeCode: async ( code, toolSessionId ) => codeInterpreterManager.executePython( code, toolSessionId ),
        sessionId,
    } );

    if ( responseMode === 'responses' ) {
        return { payload: buildResponsesPayloadFromChat( body, payload, toolRuns ) };
    }
    return { payload };
}

function normalizeCodeInterpreterRequest( body: any, endpoint: string, selectedModel: string ): { request: any; responseMode: 'chat' | 'responses' } {
    if ( endpoint === 'chat/completions' ) {
        return {
            request: { ...body, model: selectedModel, stream: false, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning },
            responseMode: 'chat',
        };
    }

    const inputText = collectTokenStrings( body?.input ).join( ' ' ).trim();
    const instructionsText = collectTokenStrings( body?.instructions ).join( ' ' ).trim();
    const messages = [] as Array<{ role: string; content: string }>;

    if ( instructionsText ) messages.push( { role: 'system', content: instructionsText } );
    if ( inputText ) messages.push( { role: 'user', content: inputText } );

    return {
        request: {
            model: selectedModel, messages, temperature: body.temperature, top_p: body.top_p,
            max_tokens: body.max_output_tokens ?? body.max_tokens, presence_penalty: body.presence_penalty,
            frequency_penalty: body.frequency_penalty, seed: body.seed, stop: body.stop, stream: false,
            tools: body.tools, tool_choice: body.tool_choice, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning,
        },
        responseMode: 'responses',
    };
}

function buildResponsesPayloadFromChat( requestBody: any, chatResponse: any, toolRuns: CodeInterpreterToolRun[] ): any {
    const output: any[] = [];
    for ( const run of toolRuns ) output.push( buildCodeInterpreterCallOutput( run ) );

    const messageText = chatResponse?.choices?.[0]?.message?.content ?? '';
    output.push( {
        type: 'message',
        id: `msg_${Date.now().toString( 36 )}`,
        role: 'assistant',
        content: messageText
            ? [ { type: 'output_text', text: messageText, annotations: [], phase: 'final' } ]
            : [],
    } );

    const usage = chatResponse?.usage
        ? { input_tokens: chatResponse.usage.prompt_tokens ?? 0, output_tokens: chatResponse.usage.completion_tokens ?? 0, total_tokens: chatResponse.usage.total_tokens ?? ( ( chatResponse.usage.prompt_tokens ?? 0 ) + ( chatResponse.usage.completion_tokens ?? 0 ) ) }
        : attachUsageIfMissing( 'responses', requestBody, { output } );

    return { id: `resp_${Date.now().toString( 36 )}`, object: 'response', created: Math.floor( Date.now() / 1000 ), model: requestBody.model, output, usage };
}

function buildCodeInterpreterCallOutput( run: CodeInterpreterToolRun ): any {
    const logs = run.stderr || run.stdout || '';
    return {
        type: 'code_interpreter_call',
        id: run.id || `ci_${Date.now().toString( 36 )}`,
        code: run.code,
        status: run.exitCode === 0 ? 'completed' : 'failed',
        outputs: [ { type: 'logs', logs } ],
    };
}

function resolveCodeInterpreterSessionId( body: any ): string {
    if ( typeof body?.container === 'string' ) return body.container;
    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    for ( const tool of tools ) {
        if ( typeof tool?.container === 'string' ) return tool.container;
        if ( typeof tool?.container?.id === 'string' ) return tool.container.id;
    }
    return `ci_${Date.now().toString( 36 )}_${Math.random().toString( 36 ).slice( 2, 8 )}`;
}
