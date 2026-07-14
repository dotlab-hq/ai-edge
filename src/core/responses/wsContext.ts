import { WebSocket } from 'ws';
import type { WSConnection } from './wsTypes';

export function isWsOpen( conn: WSConnection ): boolean {
    return conn.ws.readyState === WebSocket.OPEN;
}

export function isCriticalEventType( eventType: string | undefined ): boolean {
    return eventType === 'response.completed' || eventType === 'error';
}

export function isCriticalWsFrame( frame: string ): boolean {
    try {
        const parsed = JSON.parse( frame );
        return isCriticalEventType( parsed?.type );
    } catch {
        return false;
    }
}

export function safeSend(
    ws: WebSocket,
    data: string,
    options: { critical?: boolean } = {},
): boolean {
    if ( ws.readyState !== WebSocket.OPEN ) return false;
    if ( ws.bufferedAmount > 4_194_304 ) {
        console.warn( `[ws:responses] Client buffer overflow (${ws.bufferedAmount} bytes), closing` );
        ws.close( 1009, 'Client too slow (buffer overflow)' );
        return false;
    }
    if ( !options.critical && ws.bufferedAmount > 1_048_576 ) {
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

export function emitEvent( conn: WSConnection, eventType: string, data: Record<string, unknown> ): void {
    safeSend( conn.ws, JSON.stringify( data ), { critical: isCriticalEventType( eventType ) } );
}

export function emitJson( conn: WSConnection, data: Record<string, unknown> ): void {
    safeSend( conn.ws, JSON.stringify( data ), { critical: isCriticalEventType( data.type as string | undefined ) } );
}
