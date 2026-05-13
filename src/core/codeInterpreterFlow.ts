import type { CodeInterpreterExecutionResult } from './CodeInterpreterManager';

export const CODE_INTERPRETER_TOOL_NAME = 'python';
const CODE_INTERPRETER_TOOL_ALIASES = new Set( ['python', 'code_interpreter'] );
const MAX_TOOL_STEPS = 4;

export type OpenAIToolCall = {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
};

export type CodeInterpreterToolRun = {
    id: string;
    code: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    sessionId: string;
};

export function isCodeInterpreterTool( tool: any ): boolean {
    const type = typeof tool?.type === 'string' ? tool.type : '';
    const name = typeof tool?.name === 'string' ? tool.name : '';
    return CODE_INTERPRETER_TOOL_ALIASES.has( type ) || CODE_INTERPRETER_TOOL_ALIASES.has( name );
}

export function stripCodeInterpreterTools( tools: any[] | undefined ): { tools: any[]; removed: boolean } {
    if ( !Array.isArray( tools ) ) {
        return { tools: [], removed: false };
    }

    const filtered = tools.filter( ( tool ) => !isCodeInterpreterTool( tool ) );
    return { tools: filtered, removed: filtered.length !== tools.length };
}

export function buildCodeInterpreterToolDefinition(): any {
    return {
        type: 'function',
        function: {
            name: CODE_INTERPRETER_TOOL_NAME,
            description: 'Run Python code in a sandbox and return stdout/stderr/exit code.',
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'Python code to execute in the sandbox.',
                    },
                },
                required: ['code'],
            },
        },
    };
}

export function normalizeToolChoice( toolChoice: any ): any {
    if ( !toolChoice ) {
        return undefined;
    }

    if ( toolChoice === 'required' ) {
        return {
            type: 'function',
            function: { name: CODE_INTERPRETER_TOOL_NAME },
        };
    }

    if ( toolChoice?.type === 'code_interpreter' || toolChoice?.type === 'python' ) {
        return {
            type: 'function',
            function: { name: CODE_INTERPRETER_TOOL_NAME },
        };
    }

    return toolChoice;
}

export function extractToolCallsFromChatResponse( payload: any ): OpenAIToolCall[] {
    const message = payload?.choices?.[0]?.message;
    const calls = Array.isArray( message?.tool_calls ) ? message.tool_calls : [];
    return calls.filter( ( call: any ) => call && call.type === 'function' && call.function && typeof call.function.name === 'string' );
}

export function isCodeInterpreterToolName( name: string | undefined ): boolean {
    return !!name && CODE_INTERPRETER_TOOL_ALIASES.has( name );
}

export async function runCodeInterpreterToolLoop( options: {
    request: any;
    toolDefinition: any;
    toolChoice?: any;
    callModel: ( request: any ) => Promise<{ payload: any; response: Response }>;
    onBeforeRequest?: ( request: any ) => Promise<void>;
    executeCode: ( code: string, sessionId?: string ) => Promise<CodeInterpreterExecutionResult>;
    sessionId?: string;
    maxSteps?: number;
} ): Promise<{ payload: any; toolRuns: CodeInterpreterToolRun[] }> {
    const { request, toolDefinition, toolChoice, callModel, onBeforeRequest, executeCode, sessionId } = options;
    const maxSteps = options.maxSteps ?? MAX_TOOL_STEPS;

    const messages = Array.isArray( request.messages ) ? [...request.messages] : [];
    const toolRuns: CodeInterpreterToolRun[] = [];

    let currentRequest = {
        ...request,
        messages,
        tools: mergeTools( request.tools, toolDefinition ),
        tool_choice: toolChoice,
        stream: false,
    };

    let lastPayload: any = null;

    for ( let step = 0; step < maxSteps; step += 1 ) {
        if ( onBeforeRequest ) {
            await onBeforeRequest( currentRequest );
        }

        const { payload } = await callModel( currentRequest );
        lastPayload = payload;

        const toolCalls = extractToolCallsFromChatResponse( payload );
        if ( toolCalls.length === 0 ) {
            return { payload, toolRuns };
        }

        const unsupported = toolCalls.filter( ( call ) => !isCodeInterpreterToolName( call.function?.name ) );
        if ( unsupported.length > 0 ) {
            return { payload, toolRuns };
        }

        const message = payload?.choices?.[0]?.message ?? {};
        messages.push( {
            role: 'assistant',
            content: message.content ?? '',
            tool_calls: toolCalls,
        } );

        for ( const toolCall of toolCalls ) {
            const args = safeJsonParse( toolCall.function?.arguments ) as { code?: string } | null;
            const code = typeof args?.code === 'string' ? args.code : '';
            const result = await executeCode( code, sessionId );
            toolRuns.push( {
                id: toolCall.id,
                code,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                sessionId: result.sessionId,
            } );

            messages.push( {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: buildToolResultContent( result ),
            } );
        }

        currentRequest = {
            ...currentRequest,
            messages,
        };
    }

    return { payload: lastPayload, toolRuns };
}

function mergeTools( existing: any, toolDefinition: any ): any[] {
    const tools = Array.isArray( existing ) ? [...existing] : [];
    tools.push( toolDefinition );
    return tools;
}

function safeJsonParse( value: unknown ): any {
    if ( typeof value !== 'string' ) {
        return null;
    }
    try {
        return JSON.parse( value );
    } catch {
        return null;
    }
}

function buildToolResultContent( result: CodeInterpreterExecutionResult ): string {
    return JSON.stringify( {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
    } );
}
