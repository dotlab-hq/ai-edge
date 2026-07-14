import http from 'node:http';

const KEEP_ALIVE_ENABLE_MS = 30_000;

type NodeRequestListener = ( req: http.IncomingMessage, res: http.ServerResponse ) => void;

function wrapNoDelayListener( requestListener?: NodeRequestListener ): NodeRequestListener | undefined {
    if ( !requestListener ) {
        return undefined;
    }

    return ( req, res ) => {
        const socket = res.socket;
        if ( socket ) {
            socket.setNoDelay( true );
            socket.setKeepAlive( true, KEEP_ALIVE_ENABLE_MS );
        }
        requestListener( req, res );
    };
}

export function createNodeServerWithNoDelay( requestListener?: NodeRequestListener ): http.Server {
    return http.createServer( wrapNoDelayListener( requestListener ) );
}

export function createNodeServerFactoryWithNoDelay(): typeof http.createServer {
    const factory = ( ( ...args: any[] ) => {
        if ( typeof args[0] === 'function' || args.length === 0 ) {
            return http.createServer( wrapNoDelayListener( args[0] as NodeRequestListener | undefined ) );
        }

        const requestListener = typeof args[1] === 'function'
            ? wrapNoDelayListener( args[1] as NodeRequestListener )
            : undefined;
        return http.createServer( args[0], requestListener );
    } ) as unknown as typeof http.createServer;
    return factory;
}
