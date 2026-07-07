import type { Context } from 'hono';
import { randomBytes } from 'crypto';
import { stream } from 'hono/streaming';
import {
    convertRequestToOpenAI,
    convertResponseToAnthropic,
    type AnthropicContentBlock,
    type AnthropicMessageRequest,
    type AnthropicMessageResponse,
    type OpenAIChatResponse,
    type OpenAIStreamChunk,
} from '@/package/claude-adapter';

type StreamWriter = {
    write: ( chunk: string ) => Promise<unknown>;
    writeln?: ( chunk: string ) => Promise<unknown>;
};

type SseOut = string[];

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
    reasoningEmittedStart: boolean;
    reasoningEmittedEnd: boolean;
    reasoningBlockOpen: boolean;
    reasoningSignature?: string;
    openBlockTypes: Map<number, 'text' | 'thinking' | 'tool_use' | 'server_tool_use'>;
    lastFinishReason: OpenAIStreamChunk['choices'][number]['finish_reason'] | null;
    finished: boolean;
    streamStartedAt: number;
    firstSseEmissionLogged: boolean;
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
    initialContentBlocks: Array<Record<string, any>> = [],
    requestStartedAt: number = Date.now()
): Promise<Response> {
    c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
    c.header( 'Transfer-Encoding', 'chunked' );
    c.header( 'Cache-Control', 'no-cache, no-transform' );
    c.header( 'Connection', 'keep-alive' );
    c.header( 'X-Accel-Buffering', 'no' );

    return stream( c, async ( streamWriter ) => {
        const reader = response.body?.getReader();
        if ( !reader ) {
            const out: SseOut = [];
            sendErrorEventSync( out, new Error( 'Upstream response did not include a stream' ) );
            await streamWriter.write( out.join( '' ) );
            return;
        }

        const decoder = new TextDecoder();
        const state = createStreamState( originalModel, initialContentBlocks, requestStartedAt );
        const bufferChunks: string[] = [];
        let bufferLength = 0;
        let firstUpstreamChunkLogged = false;
        let clientDisconnected = false;
        const clientSignal = c.req.raw.signal;
        const onClientAbort = () => {
            clientDisconnected = true;
            reader.cancel( 'client disconnected' ).catch( () => {} );
        };
        clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

        try {
            const initialOut: SseOut = [': stream-start\n\n'];
            await flushOut( initialOut, streamWriter );

            while ( !clientDisconnected ) {
                const { done, value } = await reader.read();
                if ( done ) {
                    break;
                }

                if ( value ) {
                    const decoded = decoder.decode( value, { stream: true } );
                    if ( !firstUpstreamChunkLogged ) {
                        firstUpstreamChunkLogged = true;
                        console.info( `[anthropic-bridge] first_upstream_chunk model=${originalModel} firstByteMs=${Date.now() - requestStartedAt}` );
                    }

                    bufferChunks.push( decoded );
                    bufferLength += decoded.length;
                }

                const joined = bufferChunks.length === 1 ? bufferChunks[0]! : bufferChunks.join( '' );
                const { events, remainder } = consumeSseBlocks( joined );
                bufferChunks.length = 0;
                if ( remainder ) {
                    bufferChunks.push( remainder );
                }
                bufferLength = remainder.length;

                const out: SseOut = [];
                for ( const eventBlock of events ) {
                    const finished = processSseBlockSync( eventBlock, state, out );
                    if ( finished ) {
                        await flushOut( out, streamWriter );
                        console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
                        reader.releaseLock();
                        return;
                    }
                }
                if ( out.length ) {
                    await flushOut( out, streamWriter );
                }
            }

            const tail = decoder.decode();
            if ( tail ) {
                bufferChunks.push( tail );
            }
            const joined = bufferChunks.length > 0 ? bufferChunks.join( '' ) : '';
            const { events } = consumeSseBlocks( joined );
            const out: SseOut = [];
            for ( const eventBlock of events ) {
                const finished = processSseBlockSync( eventBlock, state, out );
                if ( finished ) {
                    await flushOut( out, streamWriter );
                    console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
                    reader.releaseLock();
                    return;
                }
            }

            if ( !state.finished ) {
                finishStreamSync( state, out );
            }
            if ( out.length ) {
                await flushOut( out, streamWriter );
            }
        } catch ( error: any ) {
            const errOut: SseOut = [];
            sendErrorEventSync( errOut, error instanceof Error ? error : new Error( String( error ) ) );
            try {
                await flushOut( errOut, streamWriter );
            } catch {
                /* ignore secondary error */
            }
        } finally {
            clientSignal.removeEventListener( 'abort', onClientAbort );
            if ( !clientDisconnected ) {
                console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
            }
            try { reader.releaseLock(); } catch { /* ignore */ }
        }
    } );
}

async function flushOut(
    out: SseOut,
    streamWriter: StreamWriter,
    heartbeat?: { kick: () => void }
): Promise<void> {
    if ( !out.length ) return;
    const payload = out.join( '' );
    out.length = 0;
    await streamWriter.write( payload );
    heartbeat?.kick();
}

export async function relayUpstreamToStreamWriter(
    c: Context,
    response: Response,
    originalModel: string,
    streamWriter: StreamWriter,
    initialContentBlocks: Array<Record<string, any>> = [],
    requestStartedAt: number = Date.now()
): Promise<void> {
    const reader = response.body?.getReader();
    if ( !reader ) {
        const out: SseOut = [];
        sendErrorEventSync( out, new Error( 'Upstream response did not include a stream' ) );
        await streamWriter.write( out.join( '' ) );
        return;
    }

    const decoder = new TextDecoder();
    const state = createStreamState( originalModel, initialContentBlocks, requestStartedAt );
    const bufferChunks: string[] = [];
    let bufferLength = 0;
    let firstUpstreamChunkLogged = false;
    let clientDisconnected = false;

    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => {
        clientDisconnected = true;
        reader.cancel( 'client disconnected' ).catch( () => {} );
    };
    clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

    try {
        while ( !clientDisconnected ) {
            const { done, value } = await reader.read();
            if ( done ) {
                break;
            }

            if ( value ) {
                const decoded = decoder.decode( value, { stream: true } );
                if ( !firstUpstreamChunkLogged ) {
                    firstUpstreamChunkLogged = true;
                    console.info( `[anthropic-bridge] first_upstream_chunk model=${originalModel} firstByteMs=${Date.now() - requestStartedAt}` );
                }

                bufferChunks.push( decoded );
                bufferLength += decoded.length;
            }

            const joined = bufferChunks.length === 1 ? bufferChunks[0]! : bufferChunks.join( '' );
            const { events, remainder } = consumeSseBlocks( joined );
            bufferChunks.length = 0;
            if ( remainder ) {
                bufferChunks.push( remainder );
            }
            bufferLength = remainder.length;

            const out: SseOut = [];
            for ( const eventBlock of events ) {
                const finished = processSseBlockSync( eventBlock, state, out );
                if ( finished ) {
                    await flushOut( out, streamWriter );
                    console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
                    reader.releaseLock();
                    return;
                }
            }
            if ( out.length ) {
                await flushOut( out, streamWriter );
            }
        }

        const tail = decoder.decode();
        if ( tail ) {
            bufferChunks.push( tail );
        }
        const joined = bufferChunks.length > 0 ? bufferChunks.join( '' ) : '';
        const { events } = consumeSseBlocks( joined );
        const out: SseOut = [];
        for ( const eventBlock of events ) {
            const finished = processSseBlockSync( eventBlock, state, out );
            if ( finished ) {
                await flushOut( out, streamWriter );
                console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
                reader.releaseLock();
                return;
            }
        }

        // ── GUARANTEED: finish the stream if upstream ended without sending message_stop ──
        if ( !state.finished ) {
            finishStreamSync( state, out );
        }
        if ( out.length ) {
            await flushOut( out, streamWriter );
        }
        console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
    } catch ( error: any ) {
        console.error( `[anthropic-bridge] stream_error model=${originalModel}: ${error?.message || String( error )}` );
        const errOut: SseOut = [];

        // ── GUARANTEED: finish stream state even on error ──
        if ( !state.finished ) {
            finishStreamSync( state, errOut );
        }

        sendErrorEventSync( errOut, error instanceof Error ? error : new Error( String( error ) ) );
        try {
            await flushOut( errOut, streamWriter );
        } catch {
            /* ignore secondary error */
        }
    } finally {
        clientSignal.removeEventListener( 'abort', onClientAbort );
        if ( !clientDisconnected ) {
            console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
        }
        try { reader.releaseLock(); } catch { /* ignore */ }
    }
}

function createStreamState( originalModel: string, initialContentBlocks: Array<Record<string, any>> = [], requestStartedAt: number = Date.now() ): StreamState {
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
        reasoningEmittedStart: false,
        reasoningEmittedEnd: false,
        reasoningBlockOpen: false,
        reasoningSignature: undefined,
        openBlockTypes: new Map(),
        lastFinishReason: null,
        finished: false,
        streamStartedAt: requestStartedAt,
        firstSseEmissionLogged: false,
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

function processSseBlockSync( block: string, state: StreamState, out: SseOut ): boolean {
    const lines = block
        .split( '\n' )
        .map( ( line ) => line.trim() );

    const dataLines = lines.filter( ( line ) => line.startsWith( 'data:' ) );

    if ( !dataLines.length ) {
        if ( lines.some( ( line ) => line.startsWith( ':' ) ) ) {
            sendPingEventSync( state, out );
        }
        return false;
    }

    const data = dataLines
        .map( ( line ) => line.slice( 5 ).trimStart() )
        .join( '\n' );

    if ( !data || data === '[DONE]' ) {
        if ( !state.finished ) {
            finishStreamSync( state, out );
        }
        return state.finished;
    }

    let chunk: OpenAIStreamChunk;
    try {
        chunk = JSON.parse( data ) as OpenAIStreamChunk;
    } catch {
        return false;
    }

    return processOpenAIChunkSync( chunk, state, out );
}


function processOpenAIChunkSync( chunk: OpenAIStreamChunk, state: StreamState, out: SseOut ): boolean {
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
        return false;
    }

    if ( !state.hasStarted ) {
        sendMessageStartSync( state, out );
        state.hasStarted = true;
        emitInitialContentBlocksSync( state, out );
    }

    const delta = choice.delta;

    const reasoning = ( delta as any ).reasoning || ( delta as any ).reasoning_content || ( delta as any ).thinking || ( delta as any ).thought || ( delta as any ).reasoning_text;
    if ( typeof delta.reasoning_signature === 'string' ) {
        state.reasoningSignature = delta.reasoning_signature;
    } else if ( typeof delta.signature === 'string' ) {
        state.reasoningSignature = delta.signature;
    }

    if ( reasoning ) {
        if ( !state.reasoningEmittedStart ) {
            if ( state.textBlockOpen ) {
                sendContentBlockStopSync( state, state.contentBlockIndex, out );
                state.textBlockOpen = false;
                state.textContent = '';
                state.contentBlockIndex++;
            }
            sendThinkingBlockStartSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = true;
            state.reasoningEmittedStart = true;
        }
        sendThinkingDeltaSync( state, state.contentBlockIndex, reasoning, out );
    }

    if ( delta.content ) {
        if ( state.reasoningBlockOpen ) {
            const signature = getOrCreateThinkingSignature( state );
            sendSignatureDeltaSync( state, state.contentBlockIndex, signature, out );
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = false;
            state.reasoningEmittedEnd = true;
            state.contentBlockIndex++;
        }

        const existingType = state.openBlockTypes.get( state.contentBlockIndex );
        if ( !state.textBlockOpen || ( existingType && existingType !== 'text' ) ) {
            if ( state.textBlockOpen && existingType && existingType !== 'text' ) {
                sendContentBlockStopSync( state, state.contentBlockIndex, out );
                state.textBlockOpen = false;
                state.textContent = '';
                state.contentBlockIndex++;
            }
            sendContentBlockStartSync( state, state.contentBlockIndex, 'text', '', out );
            state.textBlockOpen = true;
        }

        state.textContent += delta.content;
        sendTextDeltaSync( state, state.contentBlockIndex, delta.content, out );
    }

    if ( delta.tool_calls ) {
        for ( const toolCall of delta.tool_calls ) {
            processToolCallDeltaSync( toolCall, state, out );
        }
    }

    if ( choice.finish_reason ) {
        state.lastFinishReason = choice.finish_reason;

        if ( state.reasoningBlockOpen ) {
            const signature = getOrCreateThinkingSignature( state );
            sendSignatureDeltaSync( state, state.contentBlockIndex, signature, out );
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = false;
            state.reasoningEmittedEnd = true;
            state.contentBlockIndex++;
        }

        if ( state.textBlockOpen ) {
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.textBlockOpen = false;
            state.textContent = '';
            state.contentBlockIndex++;
        }

        for ( const toolCall of state.currentToolCalls.values() ) {
            sendContentBlockStopSync( state, toolCall.blockIndex, out );
        }
        if ( state.currentToolCalls.size > 0 ) {
            const maxToolIndex = Math.max( ...Array.from( state.currentToolCalls.values() ).map( ( toolCall ) => toolCall.blockIndex ) );
            state.contentBlockIndex = Math.max( state.contentBlockIndex, maxToolIndex + 1 );
            state.currentToolCalls.clear();
        }
    }

    return state.finished;
}

function processToolCallDeltaSync( toolCall: NonNullable<OpenAIStreamChunk['choices'][number]['delta']['tool_calls']>[number], state: StreamState, out: SseOut ): void {
    const index = toolCall.index;
    let currentCall = state.currentToolCalls.get( index );

    if ( !currentCall ) {
        if ( state.reasoningBlockOpen ) {
            const signature = getOrCreateThinkingSignature( state );
            sendSignatureDeltaSync( state, state.contentBlockIndex, signature, out );
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = false;
            state.reasoningEmittedEnd = true;
            state.contentBlockIndex++;
        }

        if ( state.textBlockOpen ) {
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.textBlockOpen = false;
            state.textContent = '';
            state.contentBlockIndex++;
        }

        if ( !currentCall ) {
            const toolId = toolCall.id || generateUniqueToolId();
            currentCall = {
                id: toolId,
                name: toolCall.function?.name || '',
                arguments: '',
                blockIndex: state.contentBlockIndex + index,
            };
            state.currentToolCalls.set( index, currentCall );
            sendContentBlockStartSync( state, currentCall.blockIndex, 'tool_use', currentCall.name, out, currentCall.id );
        }
    }

    if ( toolCall.function?.name ) {
        currentCall.name = toolCall.function.name;
    }

    if ( toolCall.function?.arguments ) {
        currentCall.arguments += toolCall.function.arguments;
        sendInputJsonDeltaSync( state, currentCall.blockIndex, toolCall.function.arguments, out );
    }
}

function sendMessageStartSync( state: StreamState, out: SseOut ): void {
    sendSseEventSync( state, out, {
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

function sendContentBlockStartSync(
    state: StreamState | undefined,
    index: number,
    type: 'text' | 'tool_use',
    textOrName: string,
    out: SseOut,
    id?: string
): void {
    const contentBlock = type === 'text'
        ? { type: 'text', text: '' }
        : {
            type: 'tool_use',
            id: id || generateUniqueToolId(),
            name: textOrName,
            input: {},
        };

    sendSseEventSync( state, out, {
        type: 'content_block_start',
        index,
        content_block: contentBlock,
    } );

    if ( state ) {
        state.openBlockTypes.set( index, type );
    }
}

function sendThinkingBlockStartSync( state: StreamState, index: number, out: SseOut ): void {
    sendSseEventSync( state, out, {
        type: 'content_block_start',
        index,
        content_block: {
            type: 'thinking',
            thinking: '',
        },
    } );

    state.openBlockTypes.set( index, 'thinking' );
}

function emitInitialContentBlocksSync( state: StreamState, out: SseOut ): void {
    if ( state.initialContentBlocksEmitted || !state.initialContentBlocks.length ) {
        return;
    }

    for ( const block of state.initialContentBlocks ) {
        const index = state.contentBlockIndex;

        sendSseEventSync( state, out, {
            type: 'content_block_start',
            index,
            content_block: block,
        } );

        if ( block?.type === 'text' || block?.type === 'tool_use' || block?.type === 'server_tool_use' ) {
            state.openBlockTypes.set( index, block.type );
        }

        if ( block?.type === 'server_tool_use' && block?.input && typeof block.input === 'object' ) {
            sendSseEventSync( state, out, {
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify( block.input ),
                },
            } );
        }

        sendContentBlockStopSync( state, index, out );
        state.contentBlockIndex += 1;
    }

    state.initialContentBlocksEmitted = true;
}

function sendTextDeltaSync( state: StreamState | undefined, index: number, text: string, out: SseOut ): void {
    if ( state && state.openBlockTypes.get( index ) !== 'text' ) {
        return;
    }

    sendSseEventSync( state, out, {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'text_delta',
            text,
        },
    } );
}

function sendThinkingDeltaSync( state: StreamState | undefined, index: number, thinking: string, out: SseOut ): void {
    if ( state && state.openBlockTypes.get( index ) !== 'thinking' ) {
        return;
    }

    sendSseEventSync( state, out, {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'thinking_delta',
            thinking,
        },
    } );
}

function sendSignatureDeltaSync( state: StreamState | undefined, index: number, signature: string, out: SseOut ): void {
    sendSseEventSync( state, out, {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'signature_delta',
            signature,
        },
    } );
}

function getOrCreateThinkingSignature( state: StreamState ): string {
    if ( state.reasoningSignature ) {
        return state.reasoningSignature;
    }

    const signature = randomBytes( 32 ).toString( 'base64' );
    state.reasoningSignature = signature;
    return signature;
}

function sendInputJsonDeltaSync( state: StreamState | undefined, index: number, partialJson: string, out: SseOut ): void {
    if ( state ) {
        const blockType = state.openBlockTypes.get( index );
        if ( blockType !== 'tool_use' && blockType !== 'server_tool_use' ) {
            return;
        }
    }

    sendSseEventSync( state, out, {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'input_json_delta',
            partial_json: partialJson,
        },
    } );
}

function sendContentBlockStopSync( state: StreamState | undefined, index: number, out: SseOut ): void {
    sendSseEventSync( state, out, {
        type: 'content_block_stop',
        index,
    } );

    if ( state ) {
        state.openBlockTypes.delete( index );
    }
}

function finishStreamSync( state: StreamState, out: SseOut ): void {
    if ( state.finished ) {
        return;
    }

    state.finished = true;

    const stopReason = mapStopReason( state.lastFinishReason );
    sendSseEventSync( state, out, {
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

    sendSseEventSync( state, out, { type: 'message_stop' } );
}

function sendErrorEventSync( out: SseOut, error: Error ): void {
    sendSseEventSync( undefined, out, {
        type: 'error',
        error: {
            type: 'api_error',
            message: error.message,
        },
    } );

    sendSseEventSync( undefined, out, {
        type: 'message_stop',
    } );
}

function sendPingEventSync( state: StreamState | undefined, out: SseOut ): void {
    sendSseEventSync( state, out, { type: 'ping' } );
}

function sendSseEventSync( state: StreamState | undefined, out: SseOut, data: Record<string, any> ): void {
    if ( state && !state.firstSseEmissionLogged ) {
        state.firstSseEmissionLogged = true;
        console.info( `[anthropic-bridge] first_downstream_event model=${state.model} firstTokenMs=${Date.now() - state.streamStartedAt}` );
    }

    out.push( `event: ${data.type}\ndata: ${JSON.stringify( data )}\n\n` );
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
    } else if ( toolChoiceTargetsMissingTool( normalizedRequest.tool_choice, normalizedTools ) ) {
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

        if ( block.type === 'image' || block.type === 'audio' || block.type === 'file' || block.type === 'document' || block.type === 'container_upload' ) {
            normalizedContent.push( block );
            continue;
        }

        if ( block.type === 'thinking' ) {
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

    const hasToolSearchTool = tools.some( ( tool: any ) => isAnthropicToolSearchTool( tool ) );

    const normalizedTools = tools.flatMap( ( tool: any ) => {
        if ( !tool || typeof tool !== 'object' ) {
            return [];
        }

        if ( hasToolSearchTool && isAnthropicToolSearchTool( tool ) ) {
            // Custom proxy-side behavior for Anthropic tool-search: eagerly expose deferred tools
            // and remove server-only tool_search tools that are not OpenAI-convertible.
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

function toolChoiceTargetsMissingTool( toolChoice: AnthropicMessageRequest['tool_choice'], tools: NonNullable<AnthropicMessageRequest['tools']> ): boolean {
    if ( !toolChoice || toolChoice.type !== 'tool' || typeof toolChoice.name !== 'string' || !toolChoice.name ) {
        return false;
    }

    return !tools.some( ( tool ) => tool?.name === toolChoice.name );
}

function isAnthropicToolSearchTool( tool: Record<string, any> ): boolean {
    if ( typeof tool?.type === 'string' && /^tool_search_tool_(regex|bm25)_\d+$/.test( tool.type ) ) {
        return true;
    }

    if ( typeof tool?.name === 'string' && /^(tool_search_tool_regex|tool_search_tool_bm25)$/.test( tool.name ) ) {
        return true;
    }

    return false;
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
