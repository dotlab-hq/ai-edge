import net from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import app from '../server';
import { createNodeServerFactoryWithNoDelay } from './utils/proxyFetch';
import { setupResponsesWebSocket } from './core/ResponsesWebSocket';

async function isPortAvailable( port: number ): Promise<boolean> {
    return new Promise( ( resolve ) => {
        const server = net.createServer();
        server.once( 'error', () => resolve( false ) );
        server.once( 'listening', () => {
            server.close( () => resolve( true ) );
        } );
        server.listen( port );
    } );
}

async function findAvailablePort( startPort: number ): Promise<number> {
    if ( await isPortAvailable( startPort ) ) {
        return startPort;
    }

    for ( let port = startPort + 1; port < 65535; port++ ) {
        if ( await isPortAvailable( port ) ) {
            return port;
        }
    }

    return startPort;
}

const preferredPort = parseInt( process.env.AI_EDGE_PORT || process.env.PORT || '25789', 10 );
const port = await findAvailablePort( preferredPort );

if ( port !== preferredPort ) {
    console.warn( `Requested port ${preferredPort} is busy. Using ${port} instead.` );
}

const server = createAdaptorServer( {
    fetch: app.fetch,
    createServer: createNodeServerFactoryWithNoDelay() as any,
} );

setupResponsesWebSocket( server as any );

server.listen( port, () => {
    console.log( `LLM Proxy dev server running on http://localhost:${port}` );
} );
