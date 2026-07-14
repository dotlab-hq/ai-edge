import { stream } from 'hono/streaming';
import type { Context } from 'hono';
import type { AnthropicProxy } from './index';

export async function handleStreamingResponse(
    proxy: AnthropicProxy,
    c: Context,
    response: Response,
    config: any,
    selectedModel: string,
    requestedModel: string,
    webSearchResponse: any,
    requestStartedAt: number,
    bodyParsedAt: number,
    webSearchCompletedAt: number,
    upstreamResponseReceivedAt: number,
    upstreamRequestStartedAt: number
): Promise<Response> {
    const serverTiming = proxy.formatTimingEntries( {
        body_parse: bodyParsedAt - requestStartedAt,
        web_search: webSearchCompletedAt - requestStartedAt,
        upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
        total: upstreamResponseReceivedAt - upstreamRequestStartedAt,
    } );
    if ( serverTiming ) {
        c.header( 'Server-Timing', serverTiming );
    }
    console.info( `[messages] stream_started provider=${config.id} model=${selectedModel} setupMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt}` );
    proxy.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );

    c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
    c.header( 'Transfer-Encoding', 'chunked' );
    c.header( 'Cache-Control', 'no-cache, no-transform' );
    c.header( 'Connection', 'keep-alive' );
    c.header( 'X-Accel-Buffering', 'no' );
    return stream( c, async ( streamWriter ) => {
        await proxy.relayUpstreamToStreamWriter(
            c,
            response,
            requestedModel,
            streamWriter,
            webSearchResponse ? proxy.buildAnthropicWebSearchBlocks( webSearchResponse ) : undefined,
            requestStartedAt
        );
    } );
}
