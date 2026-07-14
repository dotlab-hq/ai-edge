import { mapStopReason } from './types';
import type { StreamState, SseOut, StreamWriter } from './types';

export async function flushOut( out: SseOut, streamWriter: StreamWriter ): Promise<void> {
    if ( !out.length ) return;
    const payload = out.join( '' );
    out.length = 0;
    await streamWriter.write( payload );
}

export function sendSseEventSync( state: StreamState | undefined, out: SseOut, data: Record<string, any> ): void {
    if ( state && !state.firstSseEmissionLogged ) {
        state.firstSseEmissionLogged = true;
        console.info( `[anthropic-bridge] first_downstream_event model=${state.model} firstTokenMs=${Date.now() - state.streamStartedAt}` );
    }

    out.push( `event: ${data.type}\ndata: ${JSON.stringify( data )}\n\n` );
}

export function sendMessageStartSync( state: StreamState, out: SseOut ): void {
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

export function sendContentBlockStartSync(
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
            id: id || '',
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

export function sendThinkingBlockStartSync( state: StreamState, index: number, out: SseOut ): void {
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

export function sendTextDeltaSync( state: StreamState | undefined, index: number, text: string, out: SseOut ): void {
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

export function sendThinkingDeltaSync( state: StreamState | undefined, index: number, thinking: string, out: SseOut ): void {
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

export function sendSignatureDeltaSync( state: StreamState | undefined, index: number, signature: string, out: SseOut ): void {
    sendSseEventSync( state, out, {
        type: 'content_block_delta',
        index,
        delta: {
            type: 'signature_delta',
            signature,
        },
    } );
}

export function sendInputJsonDeltaSync( state: StreamState | undefined, index: number, partialJson: string, out: SseOut ): void {
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

export function sendContentBlockStopSync( state: StreamState | undefined, index: number, out: SseOut ): void {
    sendSseEventSync( state, out, {
        type: 'content_block_stop',
        index,
    } );

    if ( state ) {
        state.openBlockTypes.delete( index );
    }
}

export function sendPingEventSync( state: StreamState | undefined, out: SseOut ): void {
    sendSseEventSync( state, out, { type: 'ping' } );
}

export function sendErrorEventSync( out: SseOut, error: Error ): void {
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

export function finishStreamSync( state: StreamState, out: SseOut ): void {
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
