import { serve } from '@hono/node-server';
import net from 'node:net';
import app from '../server';

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

serve( { fetch: app.fetch, port } );
console.log( `LLM Proxy dev server running on http://localhost:${port}` );
