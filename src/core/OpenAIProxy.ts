import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { rateLimitManager } from './RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import type { Config } from '@/schema';
import { webSearchManager, type WebSearchResponse } from './WebSearchManager';
import { codeInterpreterManager } from './CodeInterpreterManager';
import { stripFreeModifier } from '@/utils/modelIds';
import { getUnifiedModelCatalog } from '@/utils/modelCatalog';
import { formatTimingEntries } from '@/utils/timing';
import {
    buildCodeInterpreterToolDefinition,
    normalizeToolChoice,
    runCodeInterpreterToolLoop,
    stripCodeInterpreterTools,
    type CodeInterpreterToolRun,
    isCodeInterpreterTool,
} from './codeInterpreterFlow';

type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
type ReasoningEffort = NonNullable<OpenAIModelConfig['default_reasoning']>;
const AUTO_MODEL_ID = 'auto';

export class OpenAIProxy {
    private app: Hono;
    private readonly rrIndexByKey = new Map<string, number>();

    constructor() {
        this.app = new Hono();
        this.setupRoutes();
    }

    getApp(): Hono {
        return this.app;
    }

    private setupRoutes(): void {
        this.app.get( '/v1/models', ( c: Context ) => this.handleModels( c ) );
        this.app.post( '/v1/responses', ( c: Context ) => this.handleResponses( c ) );
        this.app.post( '/v1/chat/completions', ( c: Context ) => this.handleChatCompletions( c ) );
        this.app.post( '/v1/embeddings', ( c: Context ) => this.handleEmbeddings( c ) );
        this.app.post( '/v1/completions', ( c: Context ) => this.handleCompletions( c ) );
        this.app.post( '/v1/images/generations', ( c: Context ) => this.handleImageGenerations( c ) );
        this.app.post( '/v1/images/edits', ( c: Context ) => this.handleImageEdits( c ) );
    }

    private async handleModels( c: Context ) {
        try {
            const configs = CONFIG.models.openai ?? [];
            if ( !configs.length ) {
                console.error( '[/v1/models] No backend configured' );
                return c.json( { error: 'No backend configured' }, 503 );
            }

            const catalog = await getUnifiedModelCatalog( CONFIG.proxy );
            return c.json( {
                object: 'list',
                data: catalog.data,
            } );
        } catch ( error: any ) {
            console.error( '[/v1/models] Exception:', error?.message || String( error ) );
            return c.json( { error: 'Failed to fetch models' }, 500 );
        }
    }

    private async handleResponses( c: Context ) {
        return this.handleOpenAIRequest( c, 'responses' );
    }

    private async handleChatCompletions( c: Context ) {
        return this.handleOpenAIRequest( c, 'chat/completions' );
    }

    private async handleEmbeddings( c: Context ) {
        return this.proxyRequest( c, 'embeddings' );
    }

    private async handleCompletions( c: Context ) {
        return this.proxyRequest( c, 'completions' );
    }

    private async handleImageGenerations( c: Context ) {
        return this.proxyRequest( c, 'images/generations' );
    }

    private async handleImageEdits( c: Context ) {
        return this.proxyRequest( c, 'images/edits' );
    }

    private async handleOpenAIRequest( c: Context, endpoint: string ) {
        const rawBody = await c.req.json().catch( () => ( {} ) );
        const normalizedBody = this.normalizeToolSearchForEndpoint( rawBody, endpoint );

        if ( this.shouldUseOpenAICodeInterpreter( normalizedBody ) ) {
            return this.proxyCodeInterpreterRequest( c, endpoint, normalizedBody );
        }

        return this.proxyRequest( c, endpoint, 1, normalizedBody );
    }

    private normalizeToolSearchForEndpoint( body: any, endpoint: string ): any {
        if ( endpoint === 'responses' || !Array.isArray( body?.tools ) ) {
            return body;
        }

        const normalizedTools = body.tools
            .filter( ( tool: any ) => tool?.type !== 'tool_search' )
            .map( ( tool: any ) => this.removeDeferLoadingField( tool ) );

        const changed = normalizedTools.length !== body.tools.length
            || normalizedTools.some( ( tool: any, index: number ) => tool !== body.tools[index] );

        if ( !changed ) {
            return body;
        }

        const normalizedBody: any = {
            ...body,
            tools: normalizedTools,
        };

        if ( this.toolChoicePointsToMissingTool( normalizedBody.tool_choice, normalizedTools ) ) {
            delete normalizedBody.tool_choice;
        }

        return normalizedBody;
    }

    private removeDeferLoadingField( tool: any ): any {
        if ( !tool || typeof tool !== 'object' ) {
            return tool;
        }

        let changed = false;
        const nextTool = { ...tool } as Record<string, any>;

        if ( Object.prototype.hasOwnProperty.call( nextTool, 'defer_loading' ) ) {
            delete nextTool.defer_loading;
            changed = true;
        }

        if ( nextTool.function && typeof nextTool.function === 'object' && !Array.isArray( nextTool.function ) ) {
            const fn = { ...nextTool.function } as Record<string, any>;
            if ( Object.prototype.hasOwnProperty.call( fn, 'defer_loading' ) ) {
                delete fn.defer_loading;
                nextTool.function = fn;
                changed = true;
            }
        }

        return changed ? nextTool : tool;
    }

    private toolChoicePointsToMissingTool( toolChoice: any, tools: any[] ): boolean {
        if ( !toolChoice || typeof toolChoice !== 'object' ) {
            return false;
        }

        const selectedName = toolChoice?.function?.name;
        if ( typeof selectedName !== 'string' || !selectedName ) {
            return false;
        }

        const available = new Set<string>();
        for ( const tool of tools ) {
            if ( typeof tool?.function?.name === 'string' && tool.function.name ) {
                available.add( tool.function.name );
                continue;
            }
            if ( typeof tool?.name === 'string' && tool.name ) {
                available.add( tool.name );
            }
        }

        return !available.has( selectedName );
    }

    private getEffectiveRateLimit( config: OpenAIModelConfig ): Config['rateLimit'] | undefined {
        if ( config.individualLimit && config.rateLimit ) {
            return config.rateLimit;
        }
        return CONFIG.rateLimit;
    }

    private async proxyRequest( c: Context, endpoint: string, redirectDepth: number = 1, rawBody?: any ): Promise<any> {
        const requestStartedAt = Date.now();
        let bodyParsedAt = requestStartedAt;
        let webSearchCompletedAt = requestStartedAt;
        let rateLimitCompletedAt = requestStartedAt;
        let upstreamRequestStartedAt = requestStartedAt;
        let upstreamResponseReceivedAt = requestStartedAt;
        const resolvedBody = rawBody ?? await c.req.json().catch( () => ( {} ) );
        bodyParsedAt = Date.now();
        const webSearchContext = await this.prepareWebSearchForOpenAI( resolvedBody, endpoint );
        webSearchCompletedAt = Date.now();
        if ( webSearchContext.errorResponse ) {
            return c.json( webSearchContext.errorResponse.body, webSearchContext.errorResponse.status as any );
        }

        const body = webSearchContext.body;
        const modelName = body.model;
        let lastFailure: { status: number; payload: any } | null = null;

        if ( !modelName || typeof modelName !== 'string' ) {
            return c.json( {
                error: {
                    message: 'Model is required and must be a string',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const maxRedirects = 5;
        if ( redirectDepth > maxRedirects ) {
            return c.json( {
                error: {
                    message: 'Maximum redirect depth exceeded',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const matchingBackends = this.getBackendsForModel( modelName, endpoint );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No backends found for model: ${modelName}` );
            return c.json( {
                error: {
                    message: `Model not found: ${modelName}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getRoundRobinBackends( modelName, matchingBackends );
        const backendIds = backends.map( b => b.id ).join( ', ' );
        console.error( `[${endpoint}] Attempting backends for model ${modelName}: ${backendIds}` );

        for ( const config of backends ) {
            const candidateModels = this.getCandidateModelsForProvider( config, modelName );

            for ( const selectedModel of candidateModels ) {
                body.model = selectedModel;
                const upstreamBody = this.withReasoningEffort( body, config, selectedModel );

                const tokens = this.calculateTokenCount( upstreamBody );
                const rateLimit = this.getEffectiveRateLimit( config );
                const rateCheck = await rateLimitManager.checkAndConsume(
                    config.id,
                    tokens,
                    rateLimit,
                    selectedModel
                );
                rateLimitCompletedAt = Date.now();

                if ( !rateCheck.allowed ) {
                    console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens, limit: ${rateLimit?.tokensPerMinute || rateLimit?.requestsPerMinute || 'unknown'}/min` );
                    continue;
                }

                try {
                    const url = this.buildApiUrl( config, endpoint );
                    upstreamRequestStartedAt = Date.now();
                    const response = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: this.buildHeaders( config ),
                        body: JSON.stringify( upstreamBody ),
                    }, CONFIG.proxy );
                    upstreamResponseReceivedAt = Date.now();

                    if ( response.status === 429 ) {
                        continue;
                    }

                    if ( this.isRedirectStatus( response.status ) ) {
                        const location = response.headers.get( 'location' );
                        if ( location ) {
                            const redirectModel = this.extractModelFromLocation( location );
                            if ( redirectModel && redirectModel !== modelName ) {
                                body.model = redirectModel;
                                return this.proxyRequest( c, endpoint, redirectDepth + 1, body );
                            }
                        }
                    }

                    // Handle streaming responses
                    if ( upstreamBody.stream === true ) {
                        c.header( 'Content-Type', 'text/event-stream' );
                        c.header( 'Cache-Control', 'no-cache, no-transform' );
                        c.header( 'Connection', 'keep-alive' );
                        c.header( 'X-Accel-Buffering', 'no' );
                        const serverTiming = formatTimingEntries( {
                            body_parse: bodyParsedAt - requestStartedAt,
                            web_search: webSearchCompletedAt - requestStartedAt,
                            rate_limit: rateLimitCompletedAt - requestStartedAt,
                            upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
                            total: upstreamResponseReceivedAt - requestStartedAt,
                        } );
                        if ( serverTiming ) {
                            c.header( 'Server-Timing', serverTiming );
                        }

                        if ( response.body ) {
                            console.info( `[${endpoint}] stream_started provider=${config.id} model=${selectedModel} setupMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt}` );
                            return stream( c, async ( streamWriter ) => {
                                const reader = response.body!.getReader();
                                const decoder = new TextDecoder();
                                let firstChunkLogged = false;

                                try {
                                    while ( true ) {
                                        const { done, value } = await reader.read();
                                        if ( done ) break;
                                        if ( value && !firstChunkLogged ) {
                                            firstChunkLogged = true;
                                            console.info( `[${endpoint}] stream_first_chunk provider=${config.id} model=${selectedModel} firstByteMs=${Date.now() - upstreamResponseReceivedAt}` );
                                        }
                                        const chunk = decoder.decode( value, { stream: true } );
                                        await streamWriter.write( chunk );
                                    }

                                    const tail = decoder.decode();
                                    if ( tail ) {
                                        await streamWriter.write( tail );
                                    }

                                    console.info( `[${endpoint}] stream_complete provider=${config.id} model=${selectedModel} totalMs=${Date.now() - requestStartedAt}` );
                                } finally {
                                    reader.releaseLock();
                                }
                            }, async ( err, streamWriter ) => {
                                console.error( `[${endpoint}] Streaming error: ${err?.message || String( err )}` );
                                await streamWriter.writeln( `data: ${JSON.stringify( {
                                    error: {
                                        message: err?.message || 'An error occurred during streaming',
                                        type: 'upstream_error',
                                    }
                                } )}\n` );
                            } );
                        }
                    }

                    const payload = await this.parseResponsePayload( response );

                    if ( !response.ok ) {
                        lastFailure = {
                            status: response.status,
                            payload,
                        };
                        console.error( `[${endpoint}] ${response.status} from ${config?.id ?? config?.name}` );
                        continue;
                    }

                    const enrichedPayload = this.attachUsageIfMissing( endpoint, upstreamBody, payload );
                    const transformMs = Date.now() - upstreamResponseReceivedAt;
                    const totalMs = Date.now() - requestStartedAt;
                    const serverTiming = formatTimingEntries( {
                        body_parse: bodyParsedAt - requestStartedAt,
                        web_search: webSearchCompletedAt - requestStartedAt,
                        rate_limit: rateLimitCompletedAt - requestStartedAt,
                        upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
                        transform: transformMs,
                        total: totalMs,
                    } );
                    if ( serverTiming ) {
                        c.header( 'Server-Timing', serverTiming );
                    }
                    console.info( `[${endpoint}] success provider=${config.id} model=${selectedModel} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt} transformMs=${transformMs} totalMs=${totalMs}` );
                    return c.json( this.attachWebSearchMetadata( endpoint, enrichedPayload, webSearchContext.searchResponse ), response.status as any );
                } catch ( error: any ) {
                    lastFailure = {
                        status: 502,
                        payload: {
                            error: {
                                message: error?.message || 'Upstream request failed',
                                type: 'upstream_error'
                            }
                        }
                    };
                    console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                    continue;
                }
            }
        }

        if ( lastFailure ) {
            const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
            console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
            console.info( `[${endpoint}] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt}` );
            return this.sendFailurePayload( c, lastFailure.status, lastFailure.payload );
        }

        console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED - No response from any backend\nModel: ${modelName}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        console.info( `[${endpoint}] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt}` );
        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private async prepareWebSearchForOpenAI( body: any, endpoint: string ): Promise<{
        body: any;
        searchResponse?: WebSearchResponse;
        errorResponse?: { status: number; body: any };
    }> {
        const startedAt = Date.now();
        if ( !this.shouldUseOpenAIWebSearch( body ) ) {
            return { body };
        }

        if ( !webSearchManager.isEnabled() ) {
            return {
                body,
                errorResponse: {
                    status: 503,
                    body: {
                        error: {
                            message: 'Web search requested but no web search provider is configured',
                            type: 'invalid_request_error',
                        }
                    }
                }
            };
        }

        const query = this.extractOpenAIWebSearchQuery( body, endpoint );
        if ( !query ) {
            return {
                body,
                errorResponse: {
                    status: 400,
                    body: {
                        error: {
                            message: 'Unable to derive a web search query from the request',
                            type: 'invalid_request_error',
                        }
                    }
                }
            };
        }

        const searchDefaults = CONFIG.tools?.webSearch?.defaults;
        const searchResponse = await webSearchManager.search( query, {
            maxResults: searchDefaults?.maxResults ?? 6,
            expand: searchDefaults?.expandQueries,
            maxExpandedQueries: searchDefaults?.maxExpandedQueries,
            parallelQueries: searchDefaults?.parallelQueries,
            softTimeoutMs: searchDefaults?.softTimeoutMs,
            providerTimeoutMs: searchDefaults?.providerTimeoutMs,
        } );
        console.info( `[web-search] openai_prepare endpoint=${endpoint} durationMs=${Date.now() - startedAt} provider=${searchResponse.provider} cached=${searchResponse.cached} citations=${searchResponse.citations.length}` );
        return {
            body: this.injectOpenAIWebSearchContext( body, endpoint, searchResponse ),
            searchResponse,
        };
    }

    private shouldUseOpenAIWebSearch( body: any ): boolean {
        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        return tools.some( ( tool: any ) => tool?.type === 'web_search' || tool?.type === 'web_search_preview' );
    }

    private extractOpenAIWebSearchQuery( body: any, endpoint: string ): string | null {
        if ( endpoint === 'responses' ) {
            const values = this.collectTokenStrings( body?.input );
            return values.join( ' ' ).trim() || null;
        }

        if ( endpoint === 'chat/completions' ) {
            const messages = Array.isArray( body?.messages ) ? body.messages : [];
            for ( let index = messages.length - 1; index >= 0; index -= 1 ) {
                const message = messages[index];
                if ( message?.role !== 'user' ) continue;
                const values = this.collectTokenStrings( message?.content );
                const text = values.join( ' ' ).trim();
                if ( text ) return text;
            }
        }

        return null;
    }

    private injectOpenAIWebSearchContext( body: any, endpoint: string, searchResponse: WebSearchResponse ): any {
        const toolFreeBody = {
            ...body,
            tools: Array.isArray( body?.tools )
                ? body.tools.filter( ( tool: any ) => tool?.type !== 'web_search' && tool?.type !== 'web_search_preview' )
                : body?.tools,
        };
        const searchPrompt = this.buildOpenAIWebSearchPrompt( searchResponse );

        if ( endpoint === 'responses' ) {
            return {
                ...toolFreeBody,
                input: [
                    ...( Array.isArray( toolFreeBody.input ) ? toolFreeBody.input : [toolFreeBody.input].filter( Boolean ) ),
                    {
                        role: 'system',
                        content: [
                            {
                                type: 'input_text',
                                text: searchPrompt,
                            }
                        ],
                    },
                ],
            };
        }

        if ( endpoint === 'chat/completions' ) {
            return {
                ...toolFreeBody,
                messages: [
                    {
                        role: 'system',
                        content: searchPrompt,
                    },
                    ...( Array.isArray( toolFreeBody.messages ) ? toolFreeBody.messages : [] ),
                ],
            };
        }

        return toolFreeBody;
    }

    private buildOpenAIWebSearchPrompt( searchResponse: WebSearchResponse ): string {
        const citations = searchResponse.citations
            .map( ( citation, index ) => `[${index + 1}] ${citation.title} - ${citation.url}\n${citation.snippet}` )
            .join( '\n\n' );

        return [
            `Web search results for query: ${searchResponse.query}`,
            'Use these sources when answering. Cite them inline as [1], [2], etc when relevant.',
            citations,
        ].join( '\n\n' );
    }

    private attachWebSearchMetadata( endpoint: string, payload: any, searchResponse?: WebSearchResponse ): any {
        if ( !searchResponse || !payload || typeof payload !== 'object' || Array.isArray( payload ) ) {
            return payload;
        }

        if ( endpoint === 'responses' ) {
            const output = Array.isArray( payload.output ) ? payload.output : [];
            return {
                ...payload,
                output: [
                    {
                        type: 'web_search_call',
                        id: `ws_${Date.now().toString( 36 )}`,
                        status: 'completed',
                        action: {
                            type: 'search',
                            query: searchResponse.query,
                        },
                    },
                    ...output,
                ],
                web_search: {
                    provider: searchResponse.provider,
                    citations: searchResponse.citations,
                    cached: searchResponse.cached,
                },
            };
        }

        return {
            ...payload,
            web_search: {
                provider: searchResponse.provider,
                citations: searchResponse.citations,
                cached: searchResponse.cached,
            },
        };
    }

    private shouldUseOpenAICodeInterpreter( body: any ): boolean {
        if ( !codeInterpreterManager.isEnabled() ) {
            return false;
        }

        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        return tools.some( ( tool: any ) => isCodeInterpreterTool( tool ) );
    }

    private async proxyCodeInterpreterRequest( c: Context, endpoint: string, rawBody: any ): Promise<any> {
        const webSearchContext = await this.prepareWebSearchForOpenAI( rawBody, endpoint );
        if ( webSearchContext.errorResponse ) {
            return c.json( webSearchContext.errorResponse.body, webSearchContext.errorResponse.status as any );
        }

        const body = webSearchContext.body;
        const modelName = body.model;
        let lastFailure: { status: number; payload: any } | null = null;

        if ( body.stream === true ) {
            return c.json( {
                error: {
                    message: 'code_interpreter does not currently support streaming responses',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        if ( !modelName || typeof modelName !== 'string' ) {
            return c.json( {
                error: {
                    message: 'Model is required and must be a string',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const matchingBackends = this.getBackendsForModel( modelName, endpoint );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No backends found for model: ${modelName}` );
            return c.json( {
                error: {
                    message: `Model not found: ${modelName}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getRoundRobinBackends( modelName, matchingBackends );
        const backendIds = backends.map( b => b.id ).join( ', ' );
        console.error( `[${endpoint}] Attempting code interpreter backends for model ${modelName}: ${backendIds}` );

        for ( const config of backends ) {
            const candidateModels = this.getCandidateModelsForProvider( config, modelName );

            for ( const selectedModel of candidateModels ) {
                try {
                    const { payload } = await this.runCodeInterpreterFlow( config, body, endpoint, selectedModel );
                    const enrichedPayload = this.attachUsageIfMissing( endpoint, body, payload );
                    return c.json( this.attachWebSearchMetadata( endpoint, enrichedPayload, webSearchContext.searchResponse ), 200 );
                } catch ( error: any ) {
                    if ( error?.rateLimitExceeded ) {
                        continue;
                    }

                    lastFailure = {
                        status: error?.status ?? 502,
                        payload: error?.payload ?? {
                            error: {
                                message: error?.message || 'Upstream request failed',
                                type: 'upstream_error'
                            }
                        }
                    };
                    console.error( `[${endpoint}] Code interpreter error from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                    continue;
                }
            }
        }

        if ( lastFailure ) {
            const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
            console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
            return this.sendFailurePayload( c, lastFailure.status, lastFailure.payload );
        }

        console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED - No response from any backend\nModel: ${modelName}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private async runCodeInterpreterFlow( config: OpenAIModelConfig, body: any, endpoint: string, selectedModel: string ): Promise<{ payload: any }> {
        const { request: chatRequest, responseMode } = this.normalizeCodeInterpreterRequest( body, endpoint, selectedModel );
        const chatRequestWithReasoning = this.withReasoningEffort( chatRequest, config, selectedModel );
        const { tools } = stripCodeInterpreterTools( chatRequestWithReasoning.tools );
        const toolDefinition = buildCodeInterpreterToolDefinition();
        const toolChoice = normalizeToolChoice( body.tool_choice );
        const rateLimit = this.getEffectiveRateLimit( config );
        const upstreamEndpoint = 'chat/completions';
        const sessionId = this.resolveCodeInterpreterSessionId( body );

        const callModel = async ( request: any ) => {
            const url = this.buildApiUrl( config, upstreamEndpoint );
            const response = await fetchWithProxy( url, {
                method: 'POST',
                headers: this.buildHeaders( config ),
                body: JSON.stringify( request ),
            }, CONFIG.proxy );
            const payload = await this.parseResponsePayload( response );

            if ( !response.ok ) {
                const error = new Error( `Upstream request failed with ${response.status}` );
                ( error as any ).status = response.status;
                ( error as any ).payload = payload;
                throw error;
            }

            return { response, payload };
        };

        const onBeforeRequest = async ( request: any ) => {
            const tokens = this.calculateTokenCount( request );
            const rateCheck = await rateLimitManager.checkAndConsume(
                config.id,
                tokens,
                rateLimit,
                selectedModel
            );

            if ( !rateCheck.allowed ) {
                const error = new Error( 'Rate limit exceeded' );
                ( error as any ).rateLimitExceeded = true;
                throw error;
            }
        };

        const { payload, toolRuns } = await runCodeInterpreterToolLoop( {
            request: {
                ...chatRequestWithReasoning,
                tools,
            },
            toolDefinition,
            toolChoice,
            callModel,
            onBeforeRequest,
            executeCode: async ( code, toolSessionId ) => codeInterpreterManager.executePython( code, toolSessionId ),
            sessionId,
        } );

        if ( responseMode === 'responses' ) {
            return {
                payload: this.buildResponsesPayloadFromChat( body, payload, toolRuns ),
            };
        }

        return { payload };
    }

    private normalizeCodeInterpreterRequest( body: any, endpoint: string, selectedModel: string ): { request: any; responseMode: 'chat' | 'responses' } {
        if ( endpoint === 'chat/completions' ) {
            return {
                request: {
                    ...body,
                    model: selectedModel,
                    stream: false,
                    reasoning_effort: body.reasoning_effort,
                    reasoning: body.reasoning,
                },
                responseMode: 'chat',
            };
        }

        const inputText = this.collectTokenStrings( body?.input ).join( ' ' ).trim();
        const instructionsText = this.collectTokenStrings( body?.instructions ).join( ' ' ).trim();
        const messages = [] as Array<{ role: string; content: string }>;

        if ( instructionsText ) {
            messages.push( {
                role: 'system',
                content: instructionsText,
            } );
        }

        if ( inputText ) {
            messages.push( {
                role: 'user',
                content: inputText,
            } );
        }

        return {
            request: {
                model: selectedModel,
                messages,
                temperature: body.temperature,
                top_p: body.top_p,
                max_tokens: body.max_output_tokens ?? body.max_tokens,
                presence_penalty: body.presence_penalty,
                frequency_penalty: body.frequency_penalty,
                seed: body.seed,
                stop: body.stop,
                stream: false,
                tools: body.tools,
                tool_choice: body.tool_choice,
                reasoning_effort: body.reasoning_effort,
                reasoning: body.reasoning,
            },
            responseMode: 'responses',
        };
    }

    private buildResponsesPayloadFromChat( requestBody: any, chatResponse: any, toolRuns: CodeInterpreterToolRun[] ): any {
        const output: any[] = [];

        for ( const run of toolRuns ) {
            output.push( this.buildCodeInterpreterCallOutput( run ) );
        }

        const messageText = chatResponse?.choices?.[0]?.message?.content ?? '';
        output.push( {
            type: 'message',
            id: `msg_${Date.now().toString( 36 )}`,
            role: 'assistant',
            content: messageText
                ? [
                    {
                        type: 'output_text',
                        text: messageText,
                        annotations: [],
                        phase: 'final',
                    }
                ]
                : [],
        } );

        const usage = chatResponse?.usage
            ? {
                input_tokens: chatResponse.usage.prompt_tokens ?? 0,
                output_tokens: chatResponse.usage.completion_tokens ?? 0,
                total_tokens: chatResponse.usage.total_tokens
                    ?? ( ( chatResponse.usage.prompt_tokens ?? 0 ) + ( chatResponse.usage.completion_tokens ?? 0 ) ),
            }
            : this.buildUsageForEndpoint( 'responses', requestBody, { output } );

        return {
            id: `resp_${Date.now().toString( 36 )}`,
            object: 'response',
            created: Math.floor( Date.now() / 1000 ),
            model: requestBody.model,
            output,
            usage,
        };
    }

    private buildCodeInterpreterCallOutput( run: CodeInterpreterToolRun ): any {
        const logs = run.stderr || run.stdout || '';
        return {
            type: 'code_interpreter_call',
            id: run.id || `ci_${Date.now().toString( 36 )}`,
            code: run.code,
            status: run.exitCode === 0 ? 'completed' : 'failed',
            outputs: [
                {
                    type: 'logs',
                    logs,
                }
            ],
        };
    }

    private resolveCodeInterpreterSessionId( body: any ): string {
        if ( typeof body?.container === 'string' ) {
            return body.container;
        }

        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        for ( const tool of tools ) {
            if ( typeof tool?.container === 'string' ) {
                return tool.container;
            }
            if ( typeof tool?.container?.id === 'string' ) {
                return tool.container.id;
            }
        }

        return `ci_${Date.now().toString( 36 )}_${Math.random().toString( 36 ).slice( 2, 8 )}`;
    }

    private isRedirectStatus( status: number ): boolean {
        return [301, 302, 303, 307, 308].includes( status );
    }

    private extractModelFromLocation( location: string ): string | null {
        try {
            if ( location.includes( 'kilo-auto/' ) ) {
                const match = location.match( /kilo-auto\/([^/]+)/ );
                if ( match ) {
                    return `kilo-auto/${match[1]}`;
                }
            }
            const parts = location.split( '/' );
            const lastPart = parts[parts.length - 1];
            if ( lastPart && lastPart.length > 0 ) {
                return lastPart;
            }
        } catch {
            return null;
        }
        return null;
    }

    private getBackendsForModel( modelName: string, endpoint?: string ): OpenAIModelConfig[] {
        const configs = CONFIG.models.openai ?? [];
        const isAutoModel = this.isAutoModel( modelName );
        const modelIsListed = configs.some( config =>
            this.configHasModel( config, modelName )
        );

        const exactBackends: OpenAIModelConfig[] = [];
        const fallbackBackends: OpenAIModelConfig[] = [];

        for ( const config of configs ) {
            const matchesRequestedModel = this.configHasModel( config, modelName );
            const canRouteWithoutModelMatch = ( isAutoModel || config.randomRouting !== false ) && !matchesRequestedModel;

            // For capability-specific endpoints, only consider providers that explicitly support them.
            if ( endpoint === 'embeddings' ) {
                if ( !this.isEmbeddingsEnabled( config ) ) continue;
            } else if ( endpoint === 'images/generations' ) {
                if ( !this.isImageGenerationEnabled( config ) ) continue;
            } else if ( endpoint === 'images/edits' ) {
                if ( !this.isImageEditingEnabled( config ) ) continue;
            } else if ( endpoint === 'chat/completions' || endpoint === 'completions' || endpoint === 'responses' ) {
                if ( this.isImageOnlyConfig( config ) ) continue;
            }

            if ( matchesRequestedModel ) {
                exactBackends.push( config );
            } else if ( canRouteWithoutModelMatch ) {
                fallbackBackends.push( config );
            }
        }

        if ( isAutoModel ) {
            return fallbackBackends;
        }

        return modelIsListed ? [...exactBackends, ...fallbackBackends] : fallbackBackends;
    }

    private isAutoModel( modelName: string ): boolean {
        return stripFreeModifier( modelName ).normalizedId === AUTO_MODEL_ID;
    }

    private configHasModel( config: OpenAIModelConfig, modelName: string ): boolean {
        const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
        return config.models.some( m => {
            const candidate = typeof m === 'string' ? m : ( m as any ).model;
            return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
        } );
    }

    private isImageGenerationEnabled( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        return typeof imageModels === 'object' && imageModels?.image_generation === true;
    }

    private isEmbeddingsEnabled( config: OpenAIModelConfig ): boolean {
        return config.embeddings === true;
    }

    private isImageEditingEnabled( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        return typeof imageModels === 'object' && imageModels?.image_editing === true;
    }

    private isImageOnlyConfig( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        if ( typeof imageModels === 'boolean' ) {
            return imageModels;
        }
        return imageModels?.image_generation === true || imageModels?.image_editing === true;
    }

    private getRoundRobinBackends( modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
        if ( backends.length <= 1 ) {
            return backends;
        }

        const key = `model:${modelName}`;
        const startIndex = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return [
            ...backends.slice( startIndex ),
            ...backends.slice( 0, startIndex ),
        ];
    }

    private getNextRoundRobinConfig( key: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig | undefined {
        if ( !backends.length ) {
            return undefined;
        }

        const index = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return backends[index];
    }

    private getAndIncrementRoundRobinIndex( key: string, total: number ): number {
        if ( total <= 0 ) {
            return 0;
        }

        const current = this.rrIndexByKey.get( key ) ?? 0;
        const index = current % total;
        this.rrIndexByKey.set( key, ( index + 1 ) % total );
        return index;
    }

    private buildHeaders( config: OpenAIModelConfig ): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
            'User-Agent': 'ai-edge/1.0',
        };
    }

    private getCandidateModelsForProvider( config: OpenAIModelConfig, requestedModel: string ): string[] {
        const isAutoModel = this.isAutoModel( requestedModel );
        if ( config.randomRouting === false && !isAutoModel ) {
            return [requestedModel];
        }

        const modelNames = config.models.map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
        const requestedNormalized = stripFreeModifier( requestedModel ).normalizedId;
        const normalizedModels = modelNames.map( modelName => stripFreeModifier( modelName ).normalizedId );
        if ( !isAutoModel && normalizedModels.includes( requestedNormalized ) ) {
            return [requestedModel];
        }
        const uniqueModels = Array.from( new Set( modelNames ) );
        if ( !uniqueModels.length ) {
            return [requestedModel];
        }

        const startIndex = Math.floor( Math.random() * uniqueModels.length );
        return [
            ...uniqueModels.slice( startIndex ),
            ...uniqueModels.slice( 0, startIndex ),
        ];
    }

    private withReasoningEffort( body: any, config: OpenAIModelConfig, selectedModel: string ): any {
        if ( !this.isReasoningConfiguredForModel( config, selectedModel ) ) {
            return this.stripReasoningFields( body );
        }

        const effort = this.resolveReasoningEffort( body, config, selectedModel );
        if ( !effort || effort === 'none' ) {
            return body;
        }

        return {
            ...body,
            reasoning_effort: effort,
        };
    }

    private resolveReasoningEffort( body: any, config: OpenAIModelConfig, selectedModel: string ): ReasoningEffort | undefined {
        if ( !this.isReasoningConfiguredForModel( config, selectedModel ) ) {
            return undefined;
        }

        if ( typeof body?.reasoning_effort === 'string' ) {
            return body.reasoning_effort as ReasoningEffort;
        }

        if ( typeof body?.reasoning?.effort === 'string' ) {
            return body.reasoning.effort as ReasoningEffort;
        }

        const modelEntry = config.models.find( model => {
            const modelName = typeof model === 'string' ? model : model.model;
            return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
        } );

        if ( modelEntry && typeof modelEntry === 'object' && modelEntry.default_reasoning ) {
            return modelEntry.default_reasoning;
        }

        return config.default_reasoning;
    }

    private isReasoningConfiguredForModel( config: OpenAIModelConfig, selectedModel: string ): boolean {
        const hasProviderReasoning = Object.prototype.hasOwnProperty.call( config, 'reasoning_efforts' )
            || Object.prototype.hasOwnProperty.call( config, 'default_reasoning' );
        if ( hasProviderReasoning ) {
            return true;
        }

        const modelEntry = config.models.find( model => {
            const modelName = typeof model === 'string' ? model : model.model;
            return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
        } );

        return !!modelEntry
            && typeof modelEntry === 'object'
            && ( Object.prototype.hasOwnProperty.call( modelEntry, 'reasoning_efforts' )
                || Object.prototype.hasOwnProperty.call( modelEntry, 'default_reasoning' ) );
    }

    private stripReasoningFields( body: any ): any {
        if ( !body || typeof body !== 'object' ) {
            return body;
        }
        const { reasoning_effort, reasoning, thinking, include_reasoning, output_reasoning, ...rest } = body;
        return rest;
    }

    private async parseResponsePayload( response: Response ): Promise<any> {
        const contentType = response.headers.get( 'content-type' ) ?? '';

        if ( contentType.includes( 'application/json' ) ) {
            return response.json().catch( () => ( {
                error: {
                    message: 'Upstream returned invalid JSON',
                    type: 'upstream_error'
                }
            } ) );
        }

        const text = await response.text().catch( () => '' );
        if ( !text ) {
            return {
                error: {
                    message: response.statusText || 'Upstream request failed',
                    type: 'upstream_error'
                }
            };
        }

        return text;
    }

    private sendFailurePayload( c: Context, status: number, payload: any ) {
        if ( payload && typeof payload === 'object' ) {
            return c.json( payload, status as any );
        }
        return c.text( String( payload ?? 'Upstream request failed' ), status as any );
    }

    private buildApiUrl( config: OpenAIModelConfig, endpoint: string ): string {
        const baseUrl = this.normalizeBaseUrl( config.baseUrl );
        return `${baseUrl}/${endpoint}`;
    }

    private normalizeBaseUrl( baseUrl: string ): string {
        return baseUrl.replace( /\/+$/, '' );
    }

    private calculateTokenCount( body: any ): number {
        if ( body?.input !== undefined ) {
            const embeddingTokens = this.calculateEmbeddingTokenCount( body.input );
            if ( embeddingTokens > 0 ) {
                return embeddingTokens;
            }
        }

        return this.calculateTokenCountFromStrings( this.extractRequestTokenStrings( body ) );
    }

    private attachUsageIfMissing( endpoint: string, requestBody: any, responseData: any ): any {
        if ( !responseData || typeof responseData !== 'object' || Array.isArray( responseData ) ) {
            return responseData;
        }

        if ( responseData.usage ) {
            return responseData;
        }

        const usage = this.buildUsageForEndpoint( endpoint, requestBody, responseData );
        if ( !usage ) {
            return responseData;
        }

        return {
            ...responseData,
            usage,
        };
    }

    private buildUsageForEndpoint( endpoint: string, requestBody: any, responseData: any ): Record<string, any> | null {
        const promptTokens = this.calculateTokenCountFromStrings( this.extractRequestTokenStrings( requestBody, endpoint ), 0 );
        const completionTokens = this.calculateTokenCountFromStrings( this.extractResponseTokenStrings( endpoint, responseData ), 0 );

        if ( endpoint === 'responses' ) {
            return {
                input_tokens: promptTokens,
                input_tokens_details: {
                    cached_tokens: 0,
                },
                output_tokens: completionTokens,
                output_tokens_details: {
                    reasoning_tokens: 0,
                },
                total_tokens: promptTokens + completionTokens,
            };
        }

        if ( endpoint === 'embeddings' ) {
            const embeddingTokens = this.calculateEmbeddingTokenCount( requestBody?.input );
            return {
                prompt_tokens: embeddingTokens || promptTokens,
                total_tokens: embeddingTokens || promptTokens,
            };
        }

        if ( endpoint === 'chat/completions' || endpoint === 'completions' ) {
            return {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
            };
        }

        // Images endpoints use token usage from the response if available
        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return null;
        }

        return null;
    }

    private extractRequestTokenStrings( body: any, endpoint?: string ): string[] {
        if ( !body ) {
            return [];
        }

        if ( endpoint === 'completions' ) {
            return this.collectTokenStrings( body.prompt );
        }

        if ( endpoint === 'chat/completions' ) {
            return this.collectTokenStrings( body.messages );
        }

        if ( endpoint === 'responses' ) {
            return [
                ...this.collectTokenStrings( body.input ),
                ...this.collectTokenStrings( body.instructions ),
                ...this.collectTokenStrings( body.prompt ),
            ];
        }

        if ( endpoint === 'embeddings' ) {
            return this.collectTokenStrings( body.input );
        }

        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return this.collectTokenStrings( body.prompt );
        }

        return this.collectTokenStrings( body );
    }

    private extractResponseTokenStrings( endpoint: string, responseData: any ): string[] {
        if ( !responseData || typeof responseData !== 'object' ) {
            return [];
        }

        if ( endpoint === 'completions' || endpoint === 'chat/completions' ) {
            return this.collectTokenStrings( responseData.choices );
        }

        if ( endpoint === 'responses' ) {
            return this.collectTokenStrings( responseData.output );
        }

        if ( endpoint === 'embeddings' ) {
            return [];
        }

        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return [];
        }

        return this.collectTokenStrings( responseData );
    }

    private collectTokenStrings( value: any ): string[] {
        if ( value == null ) {
            return [];
        }

        if ( typeof value === 'string' ) {
            return [value];
        }

        if ( typeof value === 'number' || typeof value === 'boolean' ) {
            return [];
        }

        if ( Array.isArray( value ) ) {
            return value.flatMap<string>( item => this.collectTokenStrings( item ) );
        }

        if ( typeof value !== 'object' ) {
            return [];
        }

        const countableKeys = new Set( [
            'content',
            'text',
            'input',
            'prompt',
            'instructions',
            'messages',
            'message',
            'choices',
            'output',
            'tool_calls',
            'function_call',
            'arguments',
            'code',
            'logs',
            'refusal',
            'query',
            'queries',
            'variables',
            'delta',
            'file_data',
            'file_url',
            'image_url',
        ] );

        const ignoredKeys = new Set( [
            'annotations',
            'metadata',
            'usage',
            'error',
            'id',
            'role',
            'status',
            'type',
            'object',
            'model',
            'created',
            'created_at',
            'finish_reason',
            'index',
            'system_fingerprint',
            'incomplete_details',
            'reason',
        ] );

        return Object.entries( value ).flatMap<string>( ( [key, nestedValue] ) => {
            if ( ignoredKeys.has( key ) ) {
                return [];
            }

            if ( countableKeys.has( key ) ) {
                return this.collectTokenStrings( nestedValue );
            }

            return [];
        } );
    }

    private calculateTokenCountFromStrings( values: string[], fallback: number = 100 ): number {
        const total = values.reduce( ( sum: number, value: string ) =>
            sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0
        );

        return total || fallback;
    }

    private calculateEmbeddingTokenCount( input: any ): number {
        if ( input == null ) {
            return 0;
        }

        if ( typeof input === 'string' ) {
            return Math.max( 1, Math.ceil( input.length / 4 ) );
        }

        if ( typeof input === 'number' ) {
            return 1;
        }

        if ( Array.isArray( input ) ) {
            if ( input.length === 0 ) {
                return 0;
            }

            if ( input.every( item => typeof item === 'number' ) ) {
                return input.length;
            }

            return input.reduce( ( sum: number, item: any ) => sum + this.calculateEmbeddingTokenCount( item ), 0 );
        }

        if ( typeof input === 'object' ) {
            return this.collectTokenStrings( input ).reduce( ( sum: number, value: string ) =>
                sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0
            );
        }

        return 0;
    }
}

export const openAIProxy = new OpenAIProxy();
