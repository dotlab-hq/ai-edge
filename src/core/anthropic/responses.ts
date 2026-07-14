import type { Context } from 'hono';

export function sendSseErrorResponse( c: Context, errPayload: { type: string; error: { type: string; message: string } } ): ReturnType<Context['text']> {
    const errSse: string[] = [];
    errSse.push( `event: error\ndata: ${JSON.stringify( errPayload )}\n\n` );
    errSse.push( `event: message_stop\ndata: ${JSON.stringify( { type: 'message_stop' } )}\n\n` );
    c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
    c.header( 'Cache-Control', 'no-cache, no-transform' );
    c.header( 'X-Accel-Buffering', 'no' );
    return c.text( errSse.join( '' ) );
}

export function sendSseErrorResponseNoBuffering( c: Context, errPayload: { type: string; error: { type: string; message: string } } ): ReturnType<Context['text']> {
    const errSse: string[] = [];
    errSse.push( `event: error\ndata: ${JSON.stringify( errPayload )}\n\n` );
    errSse.push( `event: message_stop\ndata: ${JSON.stringify( { type: 'message_stop' } )}\n\n` );
    c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
    c.header( 'Cache-Control', 'no-cache, no-transform' );
    return c.text( errSse.join( '' ) );
}

export function handleLastFailure( c: Context, lastFailure: { status: number; payload: any }, body: any, backends: any[], endpoint: string, requestedModel: string, requestStartedAt: number, bodyParsedAt: number, webSearchCompletedAt: number ) {
    const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
    console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( ( b: any ) => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
    console.info( `[messages] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt}` );
    const errPayload = { type: 'error', error: { type: 'api_error', message: typeof lastFailure.payload === 'object' && lastFailure.payload?.error?.message ? lastFailure.payload.error.message : 'Upstream request failed' } };
    if ( body.stream === true ) {
        return sendSseErrorResponseNoBuffering( c, errPayload );
    }
    return c.json( errPayload, lastFailure.status as any );
}

export function handleAllProvidersFailed( c: Context, body: any, backends: any[], endpoint: string, requestedModel: string, requestStartedAt: number, bodyParsedAt: number, webSearchCompletedAt: number ) {
    console.error( `\n❌ [${endpoint}] ALL OPENAI PROVIDERS FAILED - No response from any backend\nModel: ${requestedModel}\nAttempted: ${backends.map( ( b: any ) => b.id ).join( ', ' )}\n` );
    console.info( `[messages] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt}` );
    const errPayload = { type: 'error', error: { type: 'internal_error', message: 'All providers failed' } };
    if ( body.stream === true ) {
        return sendSseErrorResponseNoBuffering( c, errPayload );
    }
    return c.json( errPayload, 502 );
}
