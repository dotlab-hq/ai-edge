import {
    createResponsesStreamState,
    sseEventsToWsFrames,
    emitResponsesEvent,
    finishResponsesStream,
} from './streamState';
import {
    processChatStreamChunkForResponses,
} from './streamChunk';
import { generateId } from './helpers';
import {
    emitResponsesCompleted,
    buildStreamOutputItems,
} from './events';
import type { ResponsesStreamState } from './types';
import type { WSConnection } from './wsTypes';
import { globalResponseCache } from './wsTypes';
import { isWsOpen, safeSend, isCriticalWsFrame, emitEvent } from './wsContext';

export async function streamUpstreamToWebSocket(
    conn: WSConnection,
    upstreamRes: Response,
    responseId: string,
    providerId: string,
    selectedModel: string,
    fullInput: any[],
    model: string,
    instructions: string | undefined,
    prevId: string | null,
): Promise<void> {
    const responsesState = createResponsesStreamState( { model }, Date.now() );
    responsesState.responseId = responseId;
    let completedEmitted = false;

    const reader = upstreamRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let firstChunkLogged = false;
    let clientConnected = true;

    // Keep the socket active with WebSocket pings
    const heartbeat = setInterval( () => {
        if ( !isWsOpen( conn ) || completedEmitted ) return;
        try {
            conn.ws.ping();
        } catch { /* ignore */ }
    }, 15_000 );
    if ( typeof heartbeat === 'object' && 'unref' in heartbeat ) {
        ( heartbeat as unknown as { unref: () => void } ).unref?.();
    }

    /** Emit response.completed exactly once, guaranteed. */
    const emitCompleted = () => {
        if ( completedEmitted ) return;
        completedEmitted = true;

        try {
            if ( !responsesState.finished ) {
                const out: string[] = [];
                processChatStreamChunkForResponses( null, responsesState, out );
                for ( const frame of sseEventsToWsFrames( out ) ) {
                    safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } );
                }
            }
        } catch { /* best-effort */ }

        try {
            // ponytail: always close any open reasoning/text block so output is well-formed
            if ( !responsesState.finished ) {
                const closeOut: string[] = [];
                processChatStreamChunkForResponses( null, responsesState, closeOut );
                for ( const frame of sseEventsToWsFrames( closeOut ) ) {
                    safeSend( conn.ws, frame, { critical: true } );
                }
            }
        } catch { /* best-effort */ }

        try {
            // ponytail: if model only did reasoning (no text), synthesize a message
            // so clients see a response instead of treating the result as empty.
            if ( responsesState.textItems.length === 0 && responsesState.reasoningItems.length > 0 ) {
                const summaryText = responsesState.reasoningItems.map( ( r ) => r.text ).join( '\n' ).trim()
                    || 'Reasoning completed. No final output was produced.';
                const itemId = generateId( 'msg' );
                responsesState.textItems.push( { itemId, text: summaryText } );
                const out: string[] = [];
                emitResponsesEvent( out, 'response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: responsesState.currentOutputIndex,
                    item: { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] },
                } );
                emitResponsesEvent( out, 'response.content_part.added', {
                    type: 'response.content_part.added',
                    output_index: responsesState.currentOutputIndex,
                    content_index: 0,
                    part: { type: 'output_text', text: '' },
                } );
                emitResponsesEvent( out, 'response.output_text.delta', {
                    type: 'response.output_text.delta',
                    output_index: responsesState.currentOutputIndex,
                    content_index: 0,
                    delta: summaryText,
                } );
                emitResponsesEvent( out, 'response.content_part.done', {
                    type: 'response.content_part.done',
                    output_index: responsesState.currentOutputIndex,
                    content_index: 0,
                    part: { type: 'output_text', text: summaryText },
                } );
                emitResponsesEvent( out, 'response.output_item.done', {
                    type: 'response.output_item.done',
                    output_index: responsesState.currentOutputIndex,
                    item: {
                        id: itemId,
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [ { type: 'output_text', text: summaryText, annotations: [] } ],
                    },
                } );
                responsesState.currentOutputIndex++;
                responsesState.contentBlockIndex = 0;
                for ( const frame of sseEventsToWsFrames( out ) ) {
                    safeSend( conn.ws, frame, { critical: true } );
                }
            }
        } catch { /* best-effort */ }

        try {
            const completedOut: string[] = [];
            emitResponsesCompleted( responsesState, completedOut );
            for ( const frame of sseEventsToWsFrames( completedOut ) ) {
                safeSend( conn.ws, frame, { critical: true } );
            }
            console.info( `[ws:responses] response_completed_emitted provider=${providerId} model=${selectedModel} responseId=${responseId} textItems=${responsesState.textItems.length} reasoningItems=${responsesState.reasoningItems.length}` );
        } catch ( completedErr: any ) {
            console.error( `[ws:responses] Failed to emit response.completed: ${completedErr?.message || String( completedErr )}` );
            try {
                safeSend( conn.ws, JSON.stringify( {
                    type: 'response.completed',
                    response: {
                        id: responsesState.responseId,
                        object: 'response',
                        status: 'completed',
                        created: responsesState.created,
                        model: responsesState.model,
                        output: [],
                        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    },
                } ), { critical: true } );
            } catch { /* truly nothing we can do */ }
        }
    };

    // Send initial response.created and response.in_progress
    emitEvent( conn, 'response.created', {
        type: 'response.created',
        response: {
            id: responseId,
            object: 'response',
            status: 'in_progress',
            created: responsesState.created,
            model,
            output: [],
        },
    } );
    emitEvent( conn, 'response.in_progress', {
        type: 'response.in_progress',
        response: {
            id: responseId,
            status: 'in_progress',
        },
    } );
    responsesState.hasEmittedResponse = true;

    try {
        while ( true ) {
            if ( !isWsOpen( conn ) ) {
                clientConnected = false;
                break;
            }

            const { done, value } = await reader.read();
            if ( done ) break;
            if ( process.env.AI_EDGE_DEBUG === '1' ) console.log( `[ws:responses] chunk len=${value?.length ?? 0} bufLen=${sseBuffer.length}` );

            if ( value && !firstChunkLogged ) {
                firstChunkLogged = true;
                console.info( `[ws:responses] stream_first_chunk provider=${providerId} model=${selectedModel} responseId=${responseId}` );
            }

            if ( value ) {
                sseBuffer += decoder.decode( value, { stream: true } );
            }

            // Process complete SSE events
            const parts = sseBuffer.split( '\n\n' );
            sseBuffer = parts.pop() ?? '';

            for ( const block of parts ) {
                if ( !isWsOpen( conn ) ) { clientConnected = false; break; }

                const dataLine = block.split( '\n' ).find( ( l ) => l.startsWith( 'data:' ) );
                if ( !dataLine ) continue;

                const data = dataLine.slice( 5 ).trimStart();
                const out: string[] = [];

                if ( !data || data === '[DONE]' ) {
                    processChatStreamChunkForResponses( null, responsesState, out );
                } else {
                    try {
                        const chunk = JSON.parse( data );
                        processChatStreamChunkForResponses( chunk, responsesState, out );
                    } catch { /* ignore malformed chunks */ }
                }

                for ( const eventText of out ) {
                    const wsFrames = sseEventsToWsFrames( [ eventText ] );
                    for ( const frame of wsFrames ) {
                        if ( !safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } ) ) {
                            if ( !isWsOpen( conn ) ) { clientConnected = false; break; }
                        }
                    }
                }
            }

            if ( !clientConnected ) break;
        }

        // Flush remaining buffer
        if ( clientConnected && sseBuffer.trim() ) {
            const parts = sseBuffer.split( '\n\n' );
            for ( const block of parts ) {
                if ( !isWsOpen( conn ) ) break;
                const dataLine = block.split( '\n' ).find( ( l ) => l.startsWith( 'data:' ) );
                if ( !dataLine ) continue;
                const data = dataLine.slice( 5 ).trimStart();
                const out: string[] = [];
                if ( !data || data === '[DONE]' ) {
                    processChatStreamChunkForResponses( null, responsesState, out );
                } else {
                    try {
                        const chunk = JSON.parse( data );
                        processChatStreamChunkForResponses( chunk, responsesState, out );
                    } catch { /* ignore */ }
                }
                for ( const eventText of out ) {
                    for ( const frame of sseEventsToWsFrames( [ eventText ] ) ) {
                        safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } );
                    }
                }
            }
        }
    } catch ( err: any ) {
        console.error( `[ws:responses] Stream error: ${err?.message || String( err )} provider=${providerId} model=${selectedModel} responseId=${responseId}` );

        if ( isWsOpen( conn ) ) {
            try {
                const out: string[] = [];
                processChatStreamChunkForResponses( null, responsesState, out );
                for ( const eventText of out ) {
                    for ( const frame of sseEventsToWsFrames( [ eventText ] ) ) {
                        safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } );
                    }
                }
                safeSend( conn.ws, JSON.stringify( {
                    type: 'error',
                    error: { type: 'upstream_error', message: err?.message || 'Stream error' },
                } ), { critical: true } );
            } catch { /* best-effort */ }
        }

        if ( prevId ) conn.responseCache.delete( prevId );
    } finally {
        clearInterval( heartbeat );
        emitCompleted();

        const outputItems = buildStreamOutputItems( responsesState );
        const cached: any = {
            inputItems: fullInput,
            outputItems,
            model,
            instructions,
            responseId,
            created: responsesState.created,
        };
        conn.responseCache.set( responseId, cached );
        globalResponseCache.set( responseId, cached );

        if ( clientConnected ) {
            console.info( `[ws:responses] stream_complete provider=${providerId} model=${selectedModel} responseId=${responseId}` );
        } else {
            console.info( `[ws:responses] stream_abandoned client_disconnected provider=${providerId} model=${selectedModel} responseId=${responseId}` );
        }

        try { reader.releaseLock(); } catch { /* ignore */ }
    }
}
