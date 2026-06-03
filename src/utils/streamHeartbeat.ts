export interface StreamHeartbeatOptions {
    intervalMs?: number;
    comment?: string;
    isClientConnected?: () => boolean;
}

export interface StreamHeartbeat {
    kick: () => void;
    stop: () => void;
}

const DEFAULT_INTERVAL_MS = 3000;
const DEFAULT_COMMENT = ': keepalive\n\n';

export function startStreamHeartbeat(
    write: ( chunk: string ) => unknown,
    options: StreamHeartbeatOptions = {},
): StreamHeartbeat {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const comment = options.comment ?? DEFAULT_COMMENT;
    const isClientConnected = options.isClientConnected;
    let lastActivityAt = Date.now();
    let active = true;

    const safeWrite = () => {
        if ( !active ) return;
        if ( isClientConnected && !isClientConnected() ) return;
        try {
            const result = write( comment );
            if ( result && typeof ( result as Promise<unknown> ).catch === 'function' ) {
                ( result as Promise<unknown> ).catch( () => {} );
            }
        } catch {
            // ignore — heartbeat is best-effort
        }
    };

    const interval = setInterval( () => {
        if ( !active ) return;
        if ( Date.now() - lastActivityAt >= intervalMs ) {
            safeWrite();
            lastActivityAt = Date.now();
        }
    }, intervalMs );
    if ( typeof ( interval as unknown as { unref?: () => void } ).unref === 'function' ) {
        ( interval as unknown as { unref: () => void } ).unref();
    }

    return {
        kick: () => {
            lastActivityAt = Date.now();
        },
        stop: () => {
            if ( !active ) return;
            active = false;
            clearInterval( interval );
        },
    };
}
