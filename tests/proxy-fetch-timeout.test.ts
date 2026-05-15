import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, test } from 'bun:test';
import { fetchWithProxy } from '../src/utils/proxyFetch';

test( 'fetchWithProxy aborts requests that exceed configured timeout', async () => {
  const previousTimeout = process.env.AI_EDGE_UPSTREAM_TIMEOUT_MS;
  process.env.AI_EDGE_UPSTREAM_TIMEOUT_MS = '50';

  const app = new Hono();
  app.get( '/slow', async ( c ) => {
    await new Promise( ( resolve ) => setTimeout( resolve, 300 ) );
    return c.text( 'ok' );
  } );

  const server = createAdaptorServer( { fetch: app.fetch } );
  await new Promise<void>( ( resolve ) => server.listen( 0, resolve ) );

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/slow`;

    let caught: unknown;
    try {
      await fetchWithProxy( url, { method: 'GET' } );
    } catch ( error ) {
      caught = error;
    }

    expect( caught ).toBeDefined();
    const message = String( ( caught as any )?.message ?? '' ).toLowerCase();
    expect( message.includes( 'abort' ) || message.includes( 'aborted' ) ).toBe( true );
  } finally {
    if ( previousTimeout === undefined ) {
      delete process.env.AI_EDGE_UPSTREAM_TIMEOUT_MS;
    } else {
      process.env.AI_EDGE_UPSTREAM_TIMEOUT_MS = previousTimeout;
    }
    await new Promise<void>( ( resolve, reject ) => {
      server.close( ( error ) => ( error ? reject( error ) : resolve() ) );
    } );
  }
} );
