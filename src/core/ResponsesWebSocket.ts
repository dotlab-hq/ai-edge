import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { handleResponseCreate } from './responses/wsHandler';
import { validateUpgradeAuth } from './responses/wsAuth';
import { emitJson } from './responses/wsContext';
import type { WSConnection } from './responses/wsTypes';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MISSED_PONG_LIMIT = 3;

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
            missedPongs: 0,
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

            if ( process.env.AI_EDGE_DEBUG === '1' ) console.log( `[ws:responses] ← raw msg=${JSON.stringify( msg ).slice( 0, 2000 )}` );

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
            // Log WS errors but don't close — the close event handles cleanup.
            // Most WS errors are transient (ECONNRESET, EPIPE) and the socket
            // is already in a terminal state by the time this fires.
            console.error( `[ws:responses] Error: ${err.message}` );
        } );
        ws.on( 'pong', () => { conn.alive = true; conn.missedPongs = 0; } );
        // Respond to client pings so load balancers / proxies don't kill the connection
        ws.on( 'ping', () => { try { ws.pong(); } catch { /* ignore */ } } );
    } );

    // Server-side heartbeat: if a client misses MISSED_PONG_LIMIT consecutive
    // pings it is assumed dead and terminated.
    const heartbeat = setInterval( () => {
        wss.clients.forEach( ( ws ) => {
            if ( ws.readyState !== WebSocket.OPEN ) return;
            const conn = ( ws as any ) as WSConnection;
            if ( conn.alive === false ) {
                conn.missedPongs = ( conn.missedPongs ?? 0 ) + 1;
                if ( conn.missedPongs >= MISSED_PONG_LIMIT ) {
                    ws.terminate();
                }
            } else {
                conn.alive = false;
                ws.ping();
            }
        } );
    }, HEARTBEAT_INTERVAL_MS );

    wss.on( 'close', () => clearInterval( heartbeat ) );

    console.info( `[ws:responses] WebSocket handler attached (heartbeat=${HEARTBEAT_INTERVAL_MS}ms maxMissed=${MISSED_PONG_LIMIT})` );
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
    conn.alive = false;
    if ( conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING ) {
        try { conn.ws.close(); } catch { /* ignore */ }
    }
}
