import type { IncomingMessage, Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'stream';
import { openAIProxy } from './OpenAIProxy';
import { CONFIG } from '@/utils/schema.lookup';
import {
    convertResponsesRequestToChat,
    convertChatResponseToResponses,
    createResponsesStreamState,
    processChatStreamChunkForResponses,
    emitResponsesCompleted,
    buildStreamOutputItems,
    sseEventsToWsFrames,
    type ResponsesStreamState,
} from './ResponsesConversion';

const CONNECTION_MAX_MS = 60 * 60 * 1000; // 60 minutes
const MAX_INPUT_TOKENS_BEFORE_COMPACT = 80_000;
const MAX_INPUT_CHARS_BEFORE_COMPACT = MAX_INPUT_TOKENS_BEFORE_COMPACT * 4;
const MAX_CONTEXT_MESSAGES = 80;

interface CachedResponse {
    inputItems: any[];
    outputItems: any[];
    model: string;
    instructions?: string;
}

interface WSConnection {
    ws: WebSocket;
    alive: boolean;
    timer: NodeJS.Timeout;
    queuedMessages: any[];
    inFlight: boolean;
    responseCache: Map<string, CachedResponse>;
}

function generateResponseId(): string {
    const ts = Date.now().toString( 36 );
    const rand = Math.random().toString( 36 ).substring( 2, 8 );
    return `resp_${ts}${rand}`;
}

function generateId( prefix: string ): string {
    const ts = Date.now().toString( 36 );
    const seq = Math.random().toString( 36 ).substring( 2, 8 );
    return `${prefix}_${ts}${seq}`;
}

function safeSend( ws: WebSocket, data: string, options: { critical?: boolean } = {} ): boolean {
    if ( ws.readyState !== WebSocket.OPEN ) return false;
    if ( ws.bufferedAmount > 4_194_304 ) {
        // Over 4 MB buffered — client is too slow, drop the connection
        console.warn( `[ws:responses] Client buffer overflow (${ws.bufferedAmount} bytes), closing` );
        ws.close( 1009, 'Client too slow (buffer overflow)' );
        return false;
    }
    if ( !options.critical && ws.bufferedAmount > 1_048_576 ) {
        // Over 1 MB buffered — skip non-critical chunks to let buffer drain
        // but DO NOT close the connection so response.completed can still be sent
        console.warn( `[ws:responses] Client buffer high (${ws.bufferedAmount} bytes), skipping chunk` );
        return false;
    }
    try {
        ws.send( data );
        return true;
    } catch {
        return false;
    }
}

function isWsOpen( conn: WSConnection ): boolean {
    return conn.ws.readyState === WebSocket.OPEN;
}

function emitEvent( conn: WSConnection, eventType: string, data: Record<string, unknown> ): void {
    // Codex WebSocket expects plain JSON text frames, NOT SSE format.
    // The `type` field in the JSON must be the event type (e.g., "response.created").
    safeSend( conn.ws, JSON.stringify( data ), { critical: isCriticalEventType( eventType ) } );
}

function emitJson( conn: WSConnection, data: Record<string, unknown> ): void {
    safeSend( conn.ws, JSON.stringify( data ), { critical: isCriticalEventType( data.type as string | undefined ) } );
}

function isCriticalEventType( eventType: string | undefined ): boolean {
    return eventType === 'response.completed' || eventType === 'error';
}

function isCriticalWsFrame( frame: string ): boolean {
    try {
        const parsed = JSON.parse( frame );
        return isCriticalEventType( parsed?.type );
    } catch {
        return false;
    }
}

function validateUpgradeAuth( req: IncomingMessage ): boolean {
    const requiredKey = process.env.AI_EDGE_KEY?.trim();
    if ( !requiredKey ) return true;

    const authHeader = req.headers['authorization'] as string | undefined;
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

    if ( apiKeyHeader ) {
        return apiKeyHeader.trim() === requiredKey;
    }
    if ( authHeader ) {
        const trimmed = authHeader.trim();
        const token = trimmed.toLowerCase().startsWith( 'bearer ' )
            ? trimmed.slice( 7 ).trim()
            : trimmed;
        return token === requiredKey;
    }
    return false;
}

export function setupResponsesWebSocket( server: Server ): void {
    const wss = new WebSocketServer( { noServer: true } );

    server.on( 'upgrade', ( req: IncomingMessage, socket: Duplex, head: Buffer ) => {
        try {
            const url = new URL( req.url ?? '/', `http://${req.headers.host ?? 'localhost'}` );
            const pathname = url.pathname;

            if ( pathname !== '/v1/responses' && pathname !== '/openai/v1/responses' ) {
                socket.destroy();
                return;
            }

            if ( !validateUpgradeAuth( req ) ) {
                socket.write( 'HTTP/1.1 401 Unauthorized\r\n\r\n' );
                socket.destroy();
                return;
            }

            wss.handleUpgrade( req, socket, head, ( ws ) => {
                wss.emit( 'connection', ws, req );
            } );
        } catch {
            socket.destroy();
        }
    } );

    wss.on( 'connection', ( ws: WebSocket, req: IncomingMessage ) => {
        const conn: WSConnection = {
            ws,
            alive: true,
            timer: setTimeout( () => {
                console.info( '[ws:responses] Connection timeout (60min)' );
                emitJson( conn, {
                    type: 'error',
                    status: 400,
                    error: {
                        type: 'invalid_request_error',
                        code: 'websocket_connection_limit_reached',
                        message: 'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.',
                    },
                } );
                ws.close( 1000, 'Connection limit reached (60 minutes)' );
            }, CONNECTION_MAX_MS ),
            queuedMessages: [],
            inFlight: false,
            responseCache: new Map(),
        };

        console.info( `[ws:responses] Client connected from ${req.socket.remoteAddress}` );

        ws.on( 'message', ( raw: Buffer ) => {
            let msg: any;
            try {
                msg = JSON.parse( raw.toString() );
            } catch {
                emitJson( conn, {
                    type: 'error',
                    status: 400,
                    error: { type: 'invalid_request_error', code: 'invalid_json', message: 'Invalid JSON' },
                } );
                return;
            }

            if ( msg.type === 'response.create' ) {
                conn.queuedMessages.push( msg );
                processQueue( conn );
            } else {
                emitJson( conn, {
                    type: 'error',
                    status: 400,
                    error: { type: 'invalid_request_error', code: 'invalid_message_type', message: `Unknown message type: ${msg.type}` },
                } );
            }
        } );

        ws.on( 'close', () => cleanupConnection( conn ) );
        ws.on( 'error', ( err ) => {
            console.error( `[ws:responses] Error: ${err.message}` );
            cleanupConnection( conn );
        } );
        ws.on( 'pong', () => { conn.alive = true; } );
    } );

    // Heartbeat to detect dead connections
    const heartbeat = setInterval( () => {
        wss.clients.forEach( ( ws ) => {
            if ( ws.readyState !== WebSocket.OPEN ) return;
            ( ws as any ).alive === false ? ws.terminate() : ( ( ws as any ).alive = false, ws.ping() );
        } );
    }, 30_000 );

    wss.on( 'close', () => clearInterval( heartbeat ) );

    console.info( '[ws:responses] WebSocket handler attached' );
}

function processQueue( conn: WSConnection ): void {
    if ( conn.inFlight || !conn.queuedMessages.length ) return;
    conn.inFlight = true;
    const msg = conn.queuedMessages.shift()!;
    handleResponseCreate( conn, msg ).finally( () => {
        conn.inFlight = false;
        processQueue( conn );
    } );
}

function cleanupConnection( conn: WSConnection ): void {
    clearTimeout( conn.timer );
    conn.alive = false;
    if ( conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING ) {
        try { conn.ws.close(); } catch { /* ignore */ }
    }
}

// ── Response creation ──────────────────────────────────────────

async function handleResponseCreate( conn: WSConnection, msg: any ): Promise<void> {
    // Per OpenAI spec, stream and background are not used in WebSocket mode
    const { stream: _stream, background: _background, ...payload } = msg;
    const isWarmup = payload.generate === false;
    const prevId = payload.previous_response_id || null;
    const newInput = normaliseInput( payload.input );
    const model: string | undefined = payload.model;

    if ( !model ) {
        emitJson( conn, {
            type: 'error',
            status: 400,
            error: { type: 'invalid_request_error', code: 'missing_model', message: 'model is required' },
        } );
        return;
    }

    // ── Resolve full input from cache (includes output items from prior turn) ──
    let fullInput: any[];
    let chatBody: any;

    if ( prevId ) {
        const cached = conn.responseCache.get( prevId );
        if ( !cached ) {
            emitJson( conn, {
                type: 'error',
                status: 400,
                error: {
                    type: 'invalid_request_error',
                    code: 'previous_response_not_found',
                    message: `Previous response with id '${prevId}' not found.`,
                    param: 'previous_response_id',
                },
            } );
            return;
        }

        // Merge cached input + output items + new input
        fullInput = [ ...cached.inputItems, ...cached.outputItems, ...newInput ];

        // Rebuild chatBody from full accumulated input (including cached function_call items)
        // Merge original payload fields (instructions, etc.) with current payload (tools, new settings)
        const mergedPayload = { ...payload, input: fullInput };
        if ( cached.instructions ) {
            mergedPayload.instructions = cached.instructions;
        }
        chatBody = convertResponsesRequestToChat( mergedPayload );
    } else {
        fullInput = newInput;
        chatBody = convertResponsesRequestToChat( payload );
    }

    const responseId = generateResponseId();

    // ── Warmup: cache input and return immediately ──
    if ( isWarmup ) {
        conn.responseCache.set( responseId, {
            inputItems: fullInput,
            outputItems: [],
            model,
            instructions: payload.instructions,
        } );
        emitJson( conn, {
            type: 'response.created',
            response: {
                id: responseId,
                object: 'response',
                status: 'in_progress',
                created: Math.floor( Date.now() / 1000 ),
                model,
                output: [],
            },
        } );
        return;
    }

    // ── Context management: compress if input is too large ──
    if ( shouldCompressContext( fullInput ) ) {
        const { compressed, dropped } = compressContext( fullInput );
        if ( compressed.length < fullInput.length ) {
            fullInput = compressed;
            chatBody = convertResponsesRequestToChat( { ...payload, input: fullInput } );
            console.info( `[ws:responses] context_compressed dropped=${dropped} remaining=${compressed.length}` );
        }
    }

    // ── Find upstream backend ──
    // Force streaming on the upstream request so we get chunks instead of
    // buffering the entire response. The streaming path in
    // streamUpstreamToWebSocket forwards each chunk to the client in real-time.
    chatBody.stream = true;
    chatBody.stream_options = { include_usage: true };

    console.info( `[ws:responses] upstream_request model=${model} messages=${chatBody.messages?.length ?? 0} tools=${chatBody.tools?.length ?? 0} prevId=${prevId ?? 'none'}` );
    console.info( `[ws:responses] fullInput types=${fullInput.map( ( i: any ) => i.type ?? i.role ?? '?' ).join( ',' )}` );
    // Log message roles and tool_call_ids for debugging
    if ( chatBody.messages ) {
        for ( const m of chatBody.messages ) {
            const tcIds = m.tool_calls?.map( ( tc: any ) => tc.id ) ?? [];
            console.info( `[ws:responses]   msg role=${m.role} tool_call_id=${m.tool_call_id ?? '-'} tool_calls=${tcIds.length ? tcIds.join( ',' ) : '-'}` );
        }
    }
    const result = await openAIProxy.processUpstreamWithFallback( chatBody, 'chat/completions', {
        responseId,
        model,
        stream: true,
    } );

    if ( !result.response ) {
        emitJson( conn, {
            type: 'error',
            status: result.status,
            error: result.payload?.error ?? { type: 'upstream_error', message: 'No upstream response' },
        } );
        return;
    }

    const upstreamRes = result.response;
    const providerId = result.providerId!;
    const selectedModel = result.selectedModel!;

    // ── Handle upstream errors ──
    if ( !upstreamRes.ok ) {
        const errPayload = await safeParseJson( upstreamRes );
        console.error( `[ws:responses] ${upstreamRes.status} from ${providerId} error=${JSON.stringify( errPayload?.error ?? errPayload ).slice( 0, 300 )}` );
        emitJson( conn, {
            type: 'error',
            status: upstreamRes.status,
            error: errPayload?.error ?? { type: 'upstream_error', message: `Upstream error ${upstreamRes.status}` },
        } );
        // Evict failed previous response
        if ( prevId ) conn.responseCache.delete( prevId );
        return;
    }

    // ── Streaming ──
    const streamHeader = upstreamRes.headers.get( 'content-type' ) ?? '';
    if ( streamHeader.includes( 'text/event-stream' ) && upstreamRes.body ) {
        const cachedInstructions = prevId ? conn.responseCache.get( prevId )?.instructions : undefined;
        await streamUpstreamToWebSocket( conn, upstreamRes, responseId, providerId, selectedModel, fullInput, model, cachedInstructions ?? payload.instructions, prevId );
        return;
    }

    // ── Non-streaming ──
    const chatPayload = await safeParseJson( upstreamRes );
    if ( !chatPayload || !upstreamRes.ok ) {
        emitJson( conn, {
            type: 'error',
            status: 502,
            error: { type: 'upstream_error', message: 'Failed to parse upstream response' },
        } );
        return;
    }

    const responsesPayload = convertChatResponseToResponses( chatPayload, payload );
    responsesPayload.id = responseId;

    // Cache input items + output items for chaining
    const outputItems = responsesPayload.output as any[] ?? [];
    const cachedInstructions = prevId ? conn.responseCache.get( prevId )?.instructions : undefined;
    conn.responseCache.set( responseId, {
        inputItems: fullInput,
        outputItems,
        model,
        instructions: cachedInstructions ?? payload.instructions,
    } );
    trimResponseCache( conn );

    // Send each event as a separate WebSocket message
    // NOTE: Codex WebSocket expects plain JSON with `type` as event type
    // and response objects nested under `response` key.
    emitEvent( conn, 'response.created', {
        type: 'response.created',
        response: {
            id: responseId,
            object: 'response',
            status: 'in_progress',
            created: responsesPayload.created ?? Math.floor( Date.now() / 1000 ),
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

    // Emit output item events
    for ( let i = 0; i < outputItems.length; i++ ) {
        const item = outputItems[i];

        emitEvent( conn, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: i,
            item,
        } );

        // Emit content parts for message items
        if ( item.type === 'message' && Array.isArray( item.content ) ) {
            for ( let j = 0; j < item.content.length; j++ ) {
                const part = item.content[j];
                emitEvent( conn, 'response.content_part.added', {
                    type: 'response.content_part.added',
                    output_index: i,
                    content_index: j,
                    part: { type: part.type, text: '' },
                } );

                if ( part.type === 'output_text' && typeof part.text === 'string' ) {
                    emitEvent( conn, 'response.output_text.delta', {
                        type: 'response.output_text.delta',
                        output_index: i,
                        content_index: j,
                        delta: part.text,
                    } );
                }

                emitEvent( conn, 'response.content_part.done', {
                    type: 'response.content_part.done',
                    output_index: i,
                    content_index: j,
                    part,
                } );
            }
        }

        emitEvent( conn, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: i,
            item,
        } );
    }

    emitEvent( conn, 'response.completed', {
        type: 'response.completed',
        response: {
            id: responseId,
            object: 'response',
            status: 'completed',
            created: responsesPayload.created ?? Math.floor( Date.now() / 1000 ),
            model,
            output: outputItems,
            usage: responsesPayload.usage ?? {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
            },
        },
    } );

    console.info( `[ws:responses] success provider=${providerId} model=${selectedModel}` );
}

// ── Streaming ──────────────────────────────────────────────────

async function streamUpstreamToWebSocket(
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

    // Keep the socket active with WebSocket pings. Codex expects every text
    // message on this socket to be JSON, so never send SSE comment frames here.
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
            // Close any lingering stream state
            if ( !responsesState.finished ) {
                const out: string[] = [];
                processChatStreamChunkForResponses( null, responsesState, out );
                // Convert SSE events to plain JSON for WebSocket
                for ( const frame of sseEventsToWsFrames( out ) ) {
                    safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } );
                }
            }
        } catch { /* best-effort */ }

        try {
            const completedOut: string[] = [];
            emitResponsesCompleted( responsesState, completedOut );
            // Convert SSE events to plain JSON for WebSocket
            for ( const frame of sseEventsToWsFrames( completedOut ) ) {
                safeSend( conn.ws, frame, { critical: true } );
            }
            console.info( `[ws:responses] response_completed_emitted provider=${providerId} model=${selectedModel} responseId=${responseId}` );
        } catch ( completedErr: any ) {
            console.error( `[ws:responses] Failed to emit response.completed: ${completedErr?.message || String( completedErr )}` );
            // Last resort: send minimal response.completed as plain JSON
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
    // Codex WS expects plain JSON with `type` as event type
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
            // Check client before reading more upstream data
            if ( !isWsOpen( conn ) ) {
                clientConnected = false;
                break;
            }

            const { done, value } = await reader.read();
            if ( done ) break;

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
                    // Codex WS expects plain JSON, not SSE format
                    const wsFrames = sseEventsToWsFrames( [ eventText ] );
                    for ( const frame of wsFrames ) {
                        if ( !safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } ) ) {
                            // If send failed due to high buffer, keep going for critical events
                            // Only mark disconnected if the WS is actually closed
                            if ( !isWsOpen( conn ) ) { clientConnected = false; break; }
                        }
                    }
                }
            }

            if ( !clientConnected ) break;
            // NOTE: Do NOT break when responsesState.finished becomes true here.
            // OpenAI's streaming protocol sends the `usage` chunk (with token
            // counts) as a SEPARATE SSE message AFTER the `finish_reason` chunk.
            // Breaking early would skip that usage chunk, resulting in zero token
            // counts in the response.completed event.  Instead, keep reading
            // until the upstream closes the connection (`done === true`).
        }

        // Flush remaining buffer (only if client is still connected)
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
                // Codex WS expects plain JSON, not SSE format
                for ( const eventText of out ) {
                    for ( const frame of sseEventsToWsFrames( [ eventText ] ) ) {
                        safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } );
                    }
                }
            }
        }
    } catch ( err: any ) {
        console.error( `[ws:responses] Stream error: ${err?.message || String( err )} provider=${providerId} model=${selectedModel} responseId=${responseId}` );

        // Finish stream state and emit error event
        if ( isWsOpen( conn ) ) {
            try {
                const out: string[] = [];
                processChatStreamChunkForResponses( null, responsesState, out );
                for ( const eventText of out ) {
                    for ( const frame of sseEventsToWsFrames( [ eventText ] ) ) {
                        safeSend( conn.ws, frame, { critical: isCriticalWsFrame( frame ) } );
                    }
                }
                // Send error as plain JSON (not SSE format)
                safeSend( conn.ws, JSON.stringify( {
                    type: 'error',
                    error: { type: 'upstream_error', message: err?.message || 'Stream error' },
                } ), { critical: true } );
            } catch { /* best-effort */ }
        }

        // Evict on error
        if ( prevId ) conn.responseCache.delete( prevId );
    } finally {
        clearInterval( heartbeat );

        // ── GUARANTEED: emit response.completed before returning ──
        // This MUST always run. The Codex client disconnects if it never
        // receives this event, causing "stream closed before response.completed".
        emitCompleted();

        // Build output items from stream state for caching (even if client disconnected)
        const outputItems = buildStreamOutputItems( responsesState );
        conn.responseCache.set( responseId, {
            inputItems: fullInput,
            outputItems,
            model,
            instructions,
        } );
        trimResponseCache( conn );

        if ( clientConnected ) {
            console.info( `[ws:responses] stream_complete provider=${providerId} model=${selectedModel} responseId=${responseId}` );
        } else {
            console.info( `[ws:responses] stream_abandoned client_disconnected provider=${providerId} model=${selectedModel} responseId=${responseId}` );
        }

        try { reader.releaseLock(); } catch { /* ignore */ }
    }
}

// ── Context management ─────────────────────────────────────────

function shouldCompressContext( inputItems: any[] ): boolean {
    let totalChars = 0;
    for ( const item of inputItems ) {
        totalChars += estimateItemChars( item );
        if ( totalChars > MAX_INPUT_CHARS_BEFORE_COMPACT ) {
            return true;
        }
    }
    return false;
}

function compressContext( inputItems: any[] ): { compressed: any[]; dropped: number } {
    // Preserve system/developer messages at the beginning
    const systemItems: any[] = [];
    const otherItems: any[] = [];
    for ( const item of inputItems ) {
        const role = ( item.role as string ) || '';
        if ( role === 'system' || role === 'developer' ) {
            systemItems.push( item );
        } else {
            otherItems.push( item );
        }
    }

    // If still over limit after dropping system items, truncate from the beginning
    if ( otherItems.length > MAX_CONTEXT_MESSAGES ) {
        const kept = otherItems.slice( otherItems.length - MAX_CONTEXT_MESSAGES );
        return {
            compressed: [ ...systemItems, ...kept ],
            dropped: otherItems.length - MAX_CONTEXT_MESSAGES,
        };
    }

    return { compressed: inputItems, dropped: 0 };
}

function estimateItemChars( item: any ): number {
    if ( !item || typeof item !== 'object' ) return 0;
    try {
        return JSON.stringify( item ).length;
    } catch {
        return 0;
    }
}

// ── Helpers ────────────────────────────────────────────────────

function normaliseInput( input: any ): any[] {
    if ( input == null ) return [];
    if ( typeof input === 'string' ) return [ { role: 'user', content: input } ];
    if ( Array.isArray( input ) ) return input;
    return [];
}

function trimResponseCache( conn: WSConnection ): void {
    if ( conn.responseCache.size <= 100 ) return;
    const keys = Array.from( conn.responseCache.keys() );
    for ( let i = 0; i < keys.length - 50; i++ ) {
        conn.responseCache.delete( keys[i]! );
    }
}

async function safeParseJson( res: Response ): Promise<any> {
    try {
        const ct = res.headers.get( 'content-type' ) ?? '';
        if ( ct.includes( 'application/json' ) ) {
            return await res.json();
        }
        const text = await res.text();
        return text ? JSON.parse( text ) : null;
    } catch {
        return null;
    }
}
