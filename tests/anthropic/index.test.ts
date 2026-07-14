import { describe, it, expect } from 'bun:test';

// The server imports MongoDB-backed skills proxies, whose `bson` dependency runs
// a `node:v8` static check that Bun has not implemented. Patch the probe before
// any module loads. NOTE: this runs before the dynamic import below because static
// `import` statements are hoisted; only a dynamic import() respects this ordering.
const origGetBuiltinModule = ( process as any ).getBuiltinModule?.bind( process );
( process as any ).getBuiltinModule = ( id: string ) => {
    if ( id === 'v8' ) return undefined;
    return origGetBuiltinModule ? origGetBuiltinModule( id ) : undefined;
};

const app = ( await import( '../../server' ) ).default;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function validMessagesBody( overrides: Record<string, any> = {} ) {
    return {
        model: 'claude-3-haiku-20240307',
        messages: [ { role: 'user', content: 'hi' } ],
        ...overrides,
    };
}

describe( 'Anthropic Messages', () => {
    it( 'POST /anthropic/v1/messages — valid body reaches upstream', async () => {
        const res = await app.request( '/anthropic/v1/messages', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( validMessagesBody() ),
        } );
        // Proxy validated the body and routed to an upstream (success OR 5xx from upstream).
        expect( res.status ).toBeGreaterThanOrEqual( 200 );
        expect( res.status ).not.toBe( 400 );
    }, 30000 );

    it( 'POST /anthropic/v1/messages — missing model returns 400 "Model is required"', async () => {
        const res = await app.request( '/anthropic/v1/messages', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( { messages: [ { role: 'user', content: 'hi' } ] } ),
        } );
        expect( res.status ).toBe( 400 );
        const body = await res.json() as any;
        expect( body?.error?.type ).toBe( 'invalid_request_error' );
        expect( body?.error?.message ).toMatch( /model is required/i );
    } );

    it( 'POST /anthropic/v1/messages — empty messages still attempts routing', async () => {
        const res = await app.request( '/anthropic/v1/messages', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( validMessagesBody( { messages: [] } ) ),
        } );
        // Proxy does not validate message array length, so it routes and hits the upstream.
        expect( res.status ).not.toBe( 400 );
    }, 30000 );

    it( 'POST /anthropic/v1/messages — response is Anthropic-compatible', async () => {
        const res = await app.request( '/anthropic/v1/messages', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( validMessagesBody() ),
        } );
        const body = await res.json() as any;
        // Either a successful Message envelope or an Anthropic error envelope.
        expect( [ 'message', 'error' ] ).toContain( body?.type );
        if ( body?.type === 'error' ) {
            expect( body?.error ).toBeDefined();
            expect( typeof body?.error?.message ).toBe( 'string' );
        }
    }, 30000 );
} );

describe( 'Anthropic Batches', () => {
    it( 'POST /anthropic/v1/messages/batches — returns 501 not supported', async () => {
        const res = await app.request( '/anthropic/v1/messages/batches', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( { requests: [] } ),
        } );
        expect( res.status ).toBe( 501 );
        const body = await res.json() as any;
        expect( body?.error?.message ).toMatch( /not supported/i );
    } );
} );

describe( 'Anthropic Models', () => {
    it( 'GET /anthropic/v1/models — returns 200 with model catalog', async () => {
        const res = await app.request( '/anthropic/v1/models', { method: 'GET' } );
        expect( res.status ).toBe( 200 );
        const body = await res.json() as any;
        expect( body?.object ).toBe( 'list' );
        expect( Array.isArray( body?.data ) ).toBe( true );
    } );
} );

describe( 'Skills/Files (Anthropic-compatible)', () => {
    it( 'GET /anthropic/skills — responds (route exists)', async () => {
        const res = await app.request( '/anthropic/skills', { method: 'GET' } );
        expect( res.status ).not.toBe( 404 );
    } );

    it( 'POST /anthropic/skills — with minimal body responds (route exists)', async () => {
        const res = await app.request( '/anthropic/skills', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( { name: 'test-skill' } ),
        } );
        expect( res.status ).not.toBe( 404 );
    } );

    it( 'GET /anthropic/files — responds (route exists)', async () => {
        const res = await app.request( '/anthropic/files', { method: 'GET' } );
        expect( res.status ).not.toBe( 404 );
    } );

    it( 'POST /anthropic/files — with minimal body responds (route exists)', async () => {
        const res = await app.request( '/anthropic/files', {
            method: 'POST',
            headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
            body: '--x\r\n\r\n--x--\r\n',
        } );
        expect( res.status ).not.toBe( 404 );
    } );
} );

describe( 'Skills/Files (OpenAI-compatible)', () => {
    it( 'GET /skills — responds (route exists)', async () => {
        const res = await app.request( '/skills', { method: 'GET' } );
        expect( res.status ).not.toBe( 404 );
    } );

    it( 'POST /skills — with minimal body responds (route exists)', async () => {
        const res = await app.request( '/skills', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( { name: 'test-skill' } ),
        } );
        expect( res.status ).not.toBe( 404 );
    } );

    it( 'GET /files — responds (route exists)', async () => {
        const res = await app.request( '/files', { method: 'GET' } );
        expect( res.status ).not.toBe( 404 );
    } );

    it( 'GET /skills/nonexistent — returns an error, not a missing-route 404', async () => {
        const res = await app.request( '/skills/nonexistent', { method: 'GET' } );
        expect( res.status ).not.toBe( 404 );
        const body = await res.json() as any;
        expect( body?.error ).toBeDefined();
    } );

    it( 'GET /skills/nonexistent/versions — responds (route exists)', async () => {
        const res = await app.request( '/skills/nonexistent/versions', { method: 'GET' } );
        expect( res.status ).not.toBe( 404 );
    } );
} );

describe( 'Error handling', () => {
    it( 'POST /anthropic/v1/messages — garbage JSON body handled gracefully', async () => {
        const res = await app.request( '/anthropic/v1/messages', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: '{ this is not valid json',
        } );
        // Garbage JSON is swallowed to {} → missing model → 400 (no crash).
        expect( res.status ).toBe( 400 );
        const body = await res.json() as any;
        expect( body?.error?.type ).toBe( 'invalid_request_error' );
    } );

    it( 'POST /anthropic/v1/messages — wrong shape attempts routing or returns validation error', async () => {
        const res = await app.request( '/anthropic/v1/messages', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify( { foo: 'bar', totally: 'wrong' } ),
        } );
        // No model → 400 validation error. Never a missing-route 404.
        expect( [ 400, 502 ] ).toContain( res.status );
        const body = await res.json() as any;
        expect( body ).toBeDefined();
    } );
} );
