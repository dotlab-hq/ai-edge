import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { handleResponseCreate } from './responses/wsHandler';
import { validateUpgradeAuth } from './responses/wsAuth';
import { emitJson } from './responses/wsContext';
import type { WSConnection } from './responses/wsTypes';

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
            }, 60 * 60 * 1000 ),
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
