import { createAdaptorServer, createAdaptor } from '@hono/node-server';
import { Hono } from 'hono';
import http from 'node:http';
import { expect, test } from 'bun:test';
import { streamOpenAIResponseAsAnthropic } from '../src/core/AnthropicOpenAIBridge';

const INTER_CHUNK_MS = 20;
const CHUNK_COUNT = 50;
const CHUNK_SIZE_BYTES = 1024;
const TTFT_BUDGET_MS = 500;
const INTER_CHUNK_P99_BUDGET_MS = 100;
const TOTAL_WALL_BUDGET_MS = INTER_CHUNK_MS * CHUNK_COUNT + 800;

function padToSize( base: string, size: number ): string {
    if ( base.length >= size ) return base.slice( 0, size );
    return base + ' '.repeat( size - base.length );
}

function openAIChunk( payload: string ): string {
    const body = JSON.stringify( {
        id: 'chatcmpl_bench',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'upstream-model',
        choices: [ { index: 0, delta: { content: payload }, finish_reason: null } ],
    } );
    return padToSize( `data: ${body}\n\n`, CHUNK_SIZE_BYTES );
}

function finishChunk(): string {
    const body = JSON.stringify( {
        id: 'chatcmpl_bench',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'upstream-model',
        choices: [ { index: 0, delta: {}, finish_reason: 'stop' } ],
    } );
    return `data: ${body}\n\ndata: [DONE]\n\n`;
}

interface ServerHandle {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startFakeUpstream( chunkCount: number, interChunkMs: number ): Promise<ServerHandle> {
    const sockets = new Set<http.ServerResponse>();
    const server = http.createServer( ( req, res ) => {
        if ( !req.url?.startsWith( '/v1/chat' ) ) {
            res.writeHead( 404 );
            res.end();
            return;
        }
        res.writeHead( 200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
        } );
        sockets.add( res );
        res.on( 'close', () => sockets.delete( res ) );

        let i = 0;
        const sendNext = () => {
            if ( i >= chunkCount ) {
                res.write( finishChunk() );
                res.end();
                return;
            }
            res.write( openAIChunk( `chunk-${i}` ) );
            i += 1;
            setTimeout( sendNext, interChunkMs );
        };
        setTimeout( sendNext, interChunkMs );
    } );

    await new Promise<void>( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
    const port = ( server.address() as { port: number } ).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: async () => {
            for ( const s of sockets ) {
                try { s.end(); } catch { /* ignore */ }
            }
            await new Promise<void>( ( resolve, reject ) => {
                server.close( ( err ) => err ? reject( err ) : resolve() );
            } );
        },
    };
}

async function startBridgeServer(): Promise<ServerHandle> {
    const app = new Hono();
    app.get( '/anthropic/v1/messages', async ( c ) => {
        const upstreamUrl = c.req.header( 'x-upstream-url' );
        if ( !upstreamUrl ) {
            return c.json( { error: 'missing x-upstream-url' }, 400 );
        }
        const response = await fetch( upstreamUrl, {
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
        } );
        return streamOpenAIResponseAsAnthropic( c, response, 'claude-bench' );
    } );

    const server = createAdaptorServer( { fetch: app.fetch } );
    await new Promise<void>( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
    const port = ( server.address() as { port: number } ).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: async () => {
            await new Promise<void>( ( resolve, reject ) => {
                server.close( ( err ) => err ? reject( err ) : resolve() );
            } );
        },
    };
}

function percentile( sorted: number[], p: number ): number {
    if ( !sorted.length ) return 0;
    const idx = Math.min( sorted.length - 1, Math.floor( ( p / 100 ) * sorted.length ) );
    return sorted[idx]!;
}

test( 'streaming bridge: TTFT, inter-chunk p99, and total wall stay within budget', async () => {
    const upstream = await startFakeUpstream( CHUNK_COUNT, INTER_CHUNK_MS );
    const bridge = await startBridgeServer();

    try {
        const startedAt = Date.now();
        const response = await fetch( `${bridge.baseUrl}/anthropic/v1/messages`, {
            headers: { 'x-upstream-url': upstream.baseUrl + '/v1/chat' },
        } );
        expect( response.ok ).toBe( true );
        expect( response.headers.get( 'content-type' ) ).toContain( 'text/event-stream' );

        const reader = response.body?.getReader();
        expect( reader ).toBeDefined();
        if ( !reader ) throw new Error( 'no reader' );

        const decoder = new TextDecoder();
        const arrivalTimestamps: number[] = [];
        let body = '';

        while ( true ) {
            const next = await reader.read();
            if ( next.done ) break;
            arrivalTimestamps.push( Date.now() - startedAt );
            body += decoder.decode( next.value );
        }

        const totalWallMs = Date.now() - startedAt;

        // First byte must arrive within the budget (includes TCP, proxy, upstream RTT).
        const ttft = arrivalTimestamps[0] ?? Number.POSITIVE_INFINITY;
        console.log( `[benchmark] ttft=${ttft}ms chunks=${arrivalTimestamps.length} totalWall=${totalWallMs}ms` );

        // Inter-chunk arrival deltas (the metric that reveals "stream isn't streaming").
        const deltas: number[] = [];
        for ( let i = 1; i < arrivalTimestamps.length; i += 1 ) {
            deltas.push( arrivalTimestamps[i]! - arrivalTimestamps[i - 1]! );
        }
        deltas.sort( ( a, b ) => a - b );
        const p50 = percentile( deltas, 50 );
        const p99 = percentile( deltas, 99 );
        console.log( `[benchmark] interChunk p50=${p50}ms p99=${p99}ms count=${deltas.length}` );

        // Behavioral correctness: all upstream chunks and the final marker arrived.
        expect( body ).toContain( 'stream-start' );
        expect( body ).toContain( 'message_stop' );
        for ( let i = 0; i < CHUNK_COUNT; i += 1 ) {
            expect( body ).toContain( `chunk-${i}` );
        }

        expect( ttft ).toBeLessThan( TTFT_BUDGET_MS );
        expect( p99 ).toBeLessThan( INTER_CHUNK_P99_BUDGET_MS );
        expect( totalWallMs ).toBeLessThan( TOTAL_WALL_BUDGET_MS );
    } finally {
        await upstream.close();
        await bridge.close();
    }
}, 30_000 );
