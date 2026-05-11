import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import {
    convertRequestToOpenAI,
    convertResponseToAnthropic,
    type AnthropicContentBlock,
    type AnthropicMessageRequest,
    type AnthropicMessageResponse,
    type OpenAIChatResponse,
    type OpenAIStreamChunk,
} from 'claude-adapter';

type StreamWriter = {
    write: ( chunk: string ) => Promise<unknown>;
    writeln: ( chunk: string ) => Promise<unknown>;
};

interface StreamToolCallState {
    id: string;
    name: string;
    arguments: string;
    blockIndex: number;
}

interface StreamState {
    messageId: string;
    model: string;
    responseModel: string;
    contentBlockIndex: number;
    initialContentBlocks: Array<Record<string, any>>;
    initialContentBlocksEmitted: boolean;
    serverToolUseCount: number;
    currentToolCalls: Map<number, StreamToolCallState>;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    hasStarted: boolean;
    textContent: string;
    textBlockOpen: boolean;
    lastFinishReason: OpenAIStreamChunk['choices'][number]['finish_reason'] | null;
    finished: boolean;
}

let toolIdCounter = 0;

export function convertAnthropicRequestToOpenAI(
    anthropicRequest: AnthropicMessageRequest,
    targetModel: string,
    toolFormat: 'native' | 'xml' = 'native'
) {
    return convertRequestToOpenAI( normalizeAnthropicRequest( anthropicRequest ), targetModel, toolFormat );
}

export function convertOpenAIResponseToAnthropic(
    openAIResponse: OpenAIChatResponse,
    originalModelRequested: string
): AnthropicMessageResponse {
    return convertResponseToAnthropic( openAIResponse, originalModelRequested );
}

export async function streamOpenAIResponseAsAnthropic(
    c: Context,
    response: Response,
    originalModel: string,
    initialContentBlocks: Array<Record<string, any>> = []
): Promise<Response> {
    c.header( 'Content-Type', 'text/event-stream' );
    c.header( 'Cache-Control', 'no-cache' );
    c.header( 'Connection', 'keep-alive' );
    c.header( 'X-Accel-Buffering', 'no' );

    return stream( c, async ( streamWriter ) => {
        const reader = response.body?.getReader();
        if ( !reader ) {
            await sendErrorEvent( streamWriter, new Error( 'Upstream response did not include a stream' ), originalModel );
            return;
        }

        const decoder = new TextDecoder();
        const state = createStreamState( originalModel, initialContentBlocks );
        let buffer = '';

        try {
            while ( true ) {
                const { done, value } = await reader.read();
                if ( done ) {
                    break;
                }

                buffer += decoder.decode( value, { stream: true } );
                const { events, remainder } = consumeSseBlocks( buffer );
                buffer = remainder;

                for ( const eventBlock of events ) {
                    await processSseBlock( eventBlock, state, streamWriter );
                    if ( state.finished ) {
                        return;
                    }
                }
            }

            buffer += decoder.decode();
            const { events } = consumeSseBlocks( buffer );
            for ( const eventBlock of events ) {
                await processSseBlock( eventBlock, state, streamWriter );
                if ( state.finished ) {
                    return;
                }
            }

            if ( !state.finished ) {
                await finishStream( state, streamWriter );
            }
        } catch ( error: any ) {
            await sendErrorEvent( streamWriter, error instanceof Error ? error : new Error( String( error ) ), originalModel );
        } finally {
            reader.releaseLock();
        }
    } );
}

function createStreamState( originalModel: string, initialContentBlocks: Array<Record<string, any>> = [] ): StreamState {
    const serverToolUseCount = initialContentBlocks.filter( ( block ) => block?.type === 'server_tool_use' ).length;

    return {
        messageId: `msg_${Date.now().toString( 36 )}`,
        model: originalModel,
        responseModel: '',
        contentBlockIndex: 0,
        initialContentBlocks,
        initialContentBlocksEmitted: false,
        serverToolUseCount,
        currentToolCalls: new Map(),
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        hasStarted: false,
        textContent: '',
        textBlockOpen: false,
        lastFinishReason: null,
        finished: false,
    };
}

function consumeSseBlocks( buffer: string ): { events: string[]; remainder: string } {
    const normalized = buffer.replace( /\r\n/g, '\n' );
    const parts = normalized.split( '\n\n' );
    const remainder = parts.pop() ?? '';
    return {
        events: parts.filter( Boolean ),
        remainder,
    };
}

async function processSseBlock( block: string, state: StreamState, streamWriter: StreamWriter ): Promise<void> {
    const dataLines = block
        .split( '\n' )
        .map( ( line ) => line.trim() )
        .filter( ( line ) => line.startsWith( 'data:' ) );

    if ( !dataLines.length ) {
        return;
    }

    const data = dataLines
        .map( ( line ) => line.slice( 5 ).trimStart() )
        .join( '\n' );

    if ( !data || data === '[DONE]' ) {
        if ( !state.finished ) {
            await finishStream( state, streamWriter );
        }
        return;
    }

    let chunk: OpenAIStreamChunk;
    try {
        chunk = JSON.parse( data ) as OpenAIStreamChunk;
    } catch {
        return;
    }

    await processOpenAIChunk( chunk, state, streamWriter );
}


async function processOpenAIChunk( chunk: OpenAIStreamChunk, state: StreamState, streamWriter: StreamWriter ): Promise<void> {
    if ( chunk.usage ) {
        state.inputTokens = chunk.usage.prompt_tokens;
        state.outputTokens = chunk.usage.completion_tokens;
        state.cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }

    if ( chunk.model && !state.responseModel ) {
        state.responseModel = chunk.model;
    }

    const choice = chunk.choices[0];
    if ( !choice ) {
        return;
    }

    if ( !state.hasStarted ) {
        await sendMessageStart( state, streamWriter );
        state.hasStarted = true;
        await emitInitialContentBlocks( state, streamWriter );
    }

    const delta = choice.delta;
    if ( delta.content ) {
        if ( !state.textBlockOpen ) {
            await sendContentBlockStart( state.contentBlockIndex, 'text', '', streamWriter );
            state.textBlockOpen = true;
        }

        state.textContent += delta.content;
        await sendTextDelta( state.contentBlockIndex, delta.content, streamWriter );
    }

    if ( delta.tool_calls ) {
        for ( const toolCall of delta.tool_calls ) {
            await processToolCallDelta( toolCall, state, streamWriter );
        }
    }

    if ( choice.finish_reason ) {
        state.lastFinishReason = choice.finish_reason;

        if ( state.textBlockOpen ) {
            await sendContentBlockStop( state.contentBlockIndex, streamWriter );
            state.textBlockOpen = false;
            state.textContent = '';
            state.contentBlockIndex++;
        }

        for ( const toolCall of state.currentToolCalls.values() ) {
            await sendContentBlockStop( toolCall.blockIndex, streamWriter );
        }
    }
}

async function processToolCallDelta( toolCall: NonNullable<OpenAIStreamChunk['choices'][number]['delta']['tool_calls']>[number], state: StreamState, streamWriter: StreamWriter ): Promise<void> {
    const index = toolCall.index;
    let currentCall = state.currentToolCalls.get( index );

    if ( !currentCall ) {
        if ( state.textBlockOpen ) {
            await sendContentBlockStop( state.contentBlockIndex, streamWriter );
            state.textBlockOpen = false;
            state.textContent = '';
            state.contentBlockIndex++;
        }

        const toolId = toolCall.id || generateUniqueToolId();
        currentCall = {
            id: toolId,
            name: toolCall.function?.name || '',
            arguments: '',
            blockIndex: state.contentBlockIndex + index,
        };
        state.currentToolCalls.set( index, currentCall );
        await sendContentBlockStart( currentCall.blockIndex, 'tool_use', currentCall.name, streamWriter, currentCall.id );
    }

    if ( toolCall.function?.name ) {
        currentCall.name = toolCall.function.name;
    }

    if ( toolCall.function?.arguments ) {
        currentCall.arguments += toolCall.function.arguments;
        await sendInputJsonDelta( currentCall.blockIndex, toolCall.function.arguments, streamWriter );
    }
}

async function sendMessageStart( state: StreamState, streamWriter: StreamWriter ): Promise<void> {
    await sendSseEvent( streamWriter, {
        type: 'message_start',
        message: {
            id: state.messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: state.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
                input_tokens: state.inputTokens,
                output_tokens: state.outputTokens,
                cache_read_input_tokens: state.cachedInputTokens,
                ...( state.serverToolUseCount > 0
                    ? {
                        server_tool_use: {
                            web_search_requests: state.serverToolUseCount,
                        },
                    }
                    : {} ),
            },
        },
    } );
}

async function sendContentBlockStart(
    index: number,
    type: 'text' | 'tool_use',
    textOrName: string,
    streamWriter: StreamWriter,
    id?: string
): Promise<void> {
    const contentBlock = type === 'text'
        ? { type: 'text', text: '' }
        : {
            type: 'tool_use',
            id: id || generateUniqueToolId(),
            name: textOrName,
            input: {},
        };

    await sendSseEvent( streamWriter, {
        type: 'content_block_start',
        index,
        content_block: contentBlock,
    } );
}

async function emitInitialContentBlocks( state: StreamState, streamWriter: StreamWriter ): Promise<void> {
    if ( state.initialContentBlocksEmitted || !state.initialContentBlocks.length ) {
        return;
    }

    for ( const block of state.initialContentBlocks ) {
        const index = state.contentBlockIndex;

        await sendSseEvent( streamWriter, {
            type: 'content_block_start',
            index,
            content_block: block,
        } );

        if ( block?.type === 'server_tool_use' && block?.input && typeof block.input === 'object' ) {
            await sendSseEvent( streamWriter, {
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify( block.input ),
                },
            } );
        }

        await sendContentBlockStop( index, streamWriter );
        state.contentBlockIndex += 1;
    }

    state.initialContentBlocksEmitted = true;
}

async function sendTextDelta( index: number, text: string, streamWriter: StreamWriter ): Promise<void> {
    await sendSseEvent( streamWriter, {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'text_delta',
            text,
        },
    } );
}

async function sendInputJsonDelta( index: number, partialJson: string, streamWriter: StreamWriter ): Promise<void> {
    await sendSseEvent( streamWriter, {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'input_json_delta',
            partial_json: partialJson,
        },
    } );
}

async function sendContentBlockStop( index: number, streamWriter: StreamWriter ): Promise<void> {
    await sendSseEvent( streamWriter, {
        type: 'content_block_stop',
        index,
    } );
}

async function finishStream( state: StreamState, streamWriter: StreamWriter ): Promise<void> {
    if ( state.finished ) {
        return;
    }

    state.finished = true;

    const stopReason = mapStopReason( state.lastFinishReason );
    await sendSseEvent( streamWriter, {
        type: 'message_delta',
        delta: {
            stop_reason: stopReason,
            stop_sequence: null,
        },
        usage: {
            output_tokens: state.outputTokens,
            cache_read_input_tokens: state.cachedInputTokens,
            ...( state.serverToolUseCount > 0
                ? {
                    server_tool_use: {
                        web_search_requests: state.serverToolUseCount,
                    },
                }
                : {} ),
        },
    } );

    await sendSseEvent( streamWriter, { type: 'message_stop' } );
}

async function sendErrorEvent( streamWriter: StreamWriter, error: Error, originalModel: string ): Promise<void> {
    await sendSseEvent( streamWriter, {
        type: 'error',
        error: {
            type: 'api_error',
            message: error.message,
        },
    } );

    await sendSseEvent( streamWriter, {
        type: 'message_stop',
    } );
}

async function sendSseEvent( streamWriter: StreamWriter, data: Record<string, any> ): Promise<void> {
    const payload = `event: ${data.type}\ndata: ${JSON.stringify( data )}\n\n`;
    await streamWriter.write( payload );
}

function mapStopReason( reason: OpenAIStreamChunk['choices'][number]['finish_reason'] | null ): AnthropicMessageResponse['stop_reason'] {
    switch ( reason ) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        case 'content_filter':
            return 'end_turn';
        default:
            return 'end_turn';
    }
}

function generateUniqueToolId(): string {
    toolIdCounter++;
    const timestamp = Date.now().toString( 36 );
    const counter = toolIdCounter.toString( 36 ).padStart( 4, '0' );
    const random = Math.random().toString( 36 ).substring( 2, 10 );
    return `call_${timestamp}_${counter}_${random}`;
}

function normalizeAnthropicRequest( anthropicRequest: AnthropicMessageRequest ): AnthropicMessageRequest {
    const normalizedMessages: AnthropicMessageRequest['messages'] = [];
    const normalizedSystemBlocks = normalizeSystemBlocks( anthropicRequest.system );

    for ( const message of anthropicRequest.messages ?? [] ) {
        if ( message.role === 'user' || message.role === 'assistant' ) {
            normalizedMessages.push( normalizeAnthropicMessage( message ) );
            continue;
        }

        const extractedSystemText = extractSystemTextFromMessageContent( message.content );
        if ( extractedSystemText.length > 0 ) {
            normalizedSystemBlocks.push( ...extractedSystemText.map( ( text ) => ( { type: 'text' as const, text } ) ) );
        }
    }

    const normalizedTools = normalizeAnthropicTools( anthropicRequest.tools );

    const normalizedRequest: AnthropicMessageRequest = {
        ...anthropicRequest,
        messages: normalizedMessages,
        tools: normalizedTools,
    };

    if ( normalizedSystemBlocks.length > 0 ) {
        normalizedRequest.system = normalizedSystemBlocks;
    } else {
        delete ( normalizedRequest as Partial<AnthropicMessageRequest> ).system;
    }

    if ( !normalizedTools || normalizedTools.length === 0 ) {
        delete ( normalizedRequest as Partial<AnthropicMessageRequest> ).tools;
        delete ( normalizedRequest as Partial<AnthropicMessageRequest> ).tool_choice;
    }

    return normalizedRequest;
}

function normalizeSystemBlocks( system: AnthropicMessageRequest['system'] ): { type: 'text'; text: string }[] {
    if ( !system ) {
        return [];
    }

    if ( typeof system === 'string' ) {
        return system.trim() ? [{ type: 'text', text: system }] : [];
    }

    return system
        .filter( ( block ): block is { type: 'text'; text: string } => !!block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 )
        .map( ( block ) => ( { type: 'text', text: block.text } ) );
}

function normalizeAnthropicMessage( message: AnthropicMessageRequest['messages'][number] ): AnthropicMessageRequest['messages'][number] {
    if ( typeof message.content === 'string' ) {
        return message;
    }

    const normalizedContent: AnthropicContentBlock[] = [];

    for ( const block of message.content ) {
        if ( !block ) {
            continue;
        }

        if ( block.type === 'text' ) {
            normalizedContent.push( block );
            continue;
        }

        if ( block.type === 'tool_use' ) {
            normalizedContent.push( {
                ...block,
                id: block.id || generateUniqueToolId(),
                input: isPlainObject( block.input ) ? block.input : {},
            } );
            continue;
        }

        if ( block.type === 'tool_result' ) {
            normalizedContent.push( {
                ...block,
                content: typeof block.content === 'string'
                    ? block.content
                    : block.content.filter( ( item ): item is Extract<AnthropicContentBlock, { type: 'text' }> => !!item && item.type === 'text' ),
            } );
        }
    }

    return {
        ...message,
        content: normalizedContent,
    };
}

function extractSystemTextFromMessageContent( content: AnthropicMessageRequest['messages'][number]['content'] ): string[] {
    if ( typeof content === 'string' ) {
        return content.trim() ? [content] : [];
    }

    return content
        .filter( ( block ): block is Extract<typeof block, { type: 'text' }> => !!block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 )
        .map( ( block ) => block.text );
}

function normalizeAnthropicTools( tools: AnthropicMessageRequest['tools'] ): AnthropicMessageRequest['tools'] | undefined {
    if ( !tools || tools.length === 0 ) {
        return undefined;
    }

    const normalizedTools = tools.flatMap( ( tool: any ) => {
        if ( !tool || typeof tool !== 'object' ) {
            return [];
        }

        if ( typeof tool.name === 'string' && tool.name.trim().length > 0 && isPlainObject( tool.input_schema ) ) {
            return [{
                name: tool.name,
                description: typeof tool.description === 'string' ? tool.description : tool.name,
                input_schema: normalizeJsonSchemaObject( tool.input_schema ),
            }];
        }

        if ( typeof tool.type === 'string' && tool.type.trim().length > 0 ) {
            const toolName = tool.type.replace( /[^a-zA-Z0-9_-]/g, '_' );
            return [{
                name: toolName,
                description: typeof tool.description === 'string' && tool.description.trim().length > 0
                    ? tool.description
                    : `Anthropic server tool: ${tool.type}`,
                input_schema: normalizeJsonSchemaObject( isPlainObject( tool.input_schema ) ? tool.input_schema : { type: 'object', properties: {} } ),
            }];
        }

        return [];
    } );

    return normalizedTools.length > 0 ? normalizedTools : undefined;
}

function normalizeJsonSchemaObject( schema: Record<string, any> ): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
    const normalizedType = schema.type === 'object' ? 'object' : 'object';
    const properties = isPlainObject( schema.properties ) ? schema.properties : {};
    const required = Array.isArray( schema.required ) ? schema.required.filter( ( value ): value is string => typeof value === 'string' ) : undefined;

    return {
        type: normalizedType,
        properties,
        ...( required && required.length > 0 ? { required } : {} ),
    };
}

function isPlainObject( value: unknown ): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray( value );
}
