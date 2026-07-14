import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { startStreamHeartbeat } from '@/utils/streamHeartbeat';
import { formatTimingEntries } from '@/utils/timing';
import { streamResponsesConverted } from './responsesStream';
import type { BackendState, OpenAIModelConfig } from './types';
import type { FileSearchCallItem } from '../ResponsesConversion';

export interface StreamingArgs {
    c: Context;
    state: BackendState;
    response: Response;
    endpoint: string;
    config: OpenAIModelConfig;
    selectedModel: string;
    upstreamBody: any;
    originalResponsesBody?: any;
    fileSearchCalls?: FileSearchCallItem[];
    timings: {
        requestStartedAt: number;
        bodyParsedAt: number;
        webSearchCompletedAt: number;
        rateLimitCompletedAt: number;
        upstreamRequestStartedAt: number;
        upstreamResponseReceivedAt: number;
    };
}

export async function handleStreaming( args: StreamingArgs ): Promise<Response> {
    const { c, state, response, endpoint, config, selectedModel, upstreamBody, originalResponsesBody, fileSearchCalls, timings } = args;
    const { requestStartedAt, bodyParsedAt, webSearchCompletedAt, rateLimitCompletedAt, upstreamRequestStartedAt, upstreamResponseReceivedAt } = timings;

    c.header( 'Content-Type', 'text/event-stream' );
    c.header( 'Transfer-Encoding', 'chunked' );
    c.header( 'Cache-Control', 'no-cache, no-transform' );
    c.header( 'Connection', 'keep-alive' );
    c.header( 'X-Accel-Buffering', 'no' );

    const serverTiming = formatTimingEntries( {
        body_parse: bodyParsedAt - requestStartedAt,
        web_search: webSearchCompletedAt - requestStartedAt,
        rate_limit: rateLimitCompletedAt - requestStartedAt,
        upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
        total: upstreamResponseReceivedAt - requestStartedAt,
    } );
    if ( serverTiming ) c.header( 'Server-Timing', serverTiming );

    if ( response.body ) {
        console.info( `[${endpoint}] stream_started provider=${config.id} model=${selectedModel} setupMs=${Date.now() - requestStartedAt}` );
        state.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );

        if ( originalResponsesBody ) {
            return streamResponsesConverted( c, response, originalResponsesBody, config.id, selectedModel, requestStartedAt, fileSearchCalls );
        }

        return stream( c, async ( streamWriter ) => {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let firstChunkLogged = false;
            let clientDisconnected = false;
            const heartbeat = startStreamHeartbeat( ( chunk ) => streamWriter.write( chunk ), { isClientConnected: () => !clientDisconnected } );

            const clientSignal = c.req.raw.signal;
            const onClientAbort = () => {
                clientDisconnected = true;
                reader.cancel( 'client disconnected' ).catch( () => {} );
            };
            clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

            try {
                while ( !clientDisconnected ) {
                    const { done, value } = await reader.read();
                    if ( done ) break;
                    if ( value && !firstChunkLogged ) {
                        firstChunkLogged = true;
                        console.info( `[${endpoint}] stream_first_chunk provider=${config.id} model=${selectedModel} firstByteMs=${Date.now() - upstreamResponseReceivedAt}` );
                    }
                    if ( value ) {
                        const chunk = decoder.decode( value, { stream: true } );
                        if ( chunk ) { await streamWriter.write( chunk ); heartbeat.kick(); }
                    }
                }
                if ( !clientDisconnected ) {
                    const tail = decoder.decode();
                    if ( tail ) await streamWriter.write( tail );
                    console.info( `[${endpoint}] stream_complete provider=${config.id} model=${selectedModel} totalMs=${Date.now() - requestStartedAt}` );
                }
            } finally {
                heartbeat.stop();
                clientSignal.removeEventListener( 'abort', onClientAbort );
                try { reader.releaseLock(); } catch { /* ignore */ }
            }
        }, async ( err, streamWriter ) => {
            console.error( `[${endpoint}] Streaming error: ${err?.message || String( err )}` );
            await streamWriter.writeln( `data: ${JSON.stringify( { error: { message: err?.message || 'An error occurred during streaming', type: 'upstream_error' } } )}\n` );
        } );
    }

    return c.json( { error: { message: 'No response body', type: 'internal_error' } }, 502 );
}
