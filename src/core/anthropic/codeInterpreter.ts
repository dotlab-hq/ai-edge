import type { Context } from 'hono';

export type CodeInterpreterResult =
    | { handled: false }
    | { handled: true; response: Response }
    | { handled: true; failure: { status: number; payload: any } };

// Structural type for the proxy surface used here — avoids a circular import to ./index.
type ProxyLike = {
    codeInterpreterHandler: {
        shouldUseCodeInterpreter( body: any ): boolean;
        executeToolLoop(
            request: any,
            config: any,
            requestedModel: string,
            callModel: ( request: any ) => Promise<{ payload: any; response: Response }>,
            calculateTokenCount: ( body: any ) => number,
            rateLimitManager: any,
            sessionId?: string
        ): Promise<{ payload: any; toolRuns: any[] }>;
    };
    getBackendConfigForModel( modelName: string ): any;
    normalizeBaseUrl( baseUrl: string ): string;
    withReasoningEffort( request: any, sourceBody: any, config: any, selectedModel: string ): any;
    fetchWithProxy( url: string, init: any, proxyCfg?: any, opts?: any ): Promise<Response>;
    buildHeaders( config: any, stream?: boolean ): Record<string, string>;
    parseResponsePayload( response: Response ): Promise<any>;
    calculateTokenCount( body: any ): number;
    rateLimitManager: any;
    buildCodeInterpreterSessionId(): string;
    formatTimingEntries( entries: Record<string, number> ): string | undefined;
};

export async function runCodeInterpreter(
    proxy: ProxyLike,
    c: Context,
    body: any,
    requestedModel: string,
    requestStartedAt: number,
    bodyParsedAt: number,
    webSearchCompletedAt: number
): Promise<CodeInterpreterResult> {
    if ( !proxy.codeInterpreterHandler.shouldUseCodeInterpreter( body ) ) {
        return { handled: false };
    }

    try {
        const toolRunResult = await proxy.codeInterpreterHandler.executeToolLoop(
            body,
            proxy.getBackendConfigForModel( requestedModel ),
            requestedModel,
            async ( request: any ) => {
                const config = proxy.getBackendConfigForModel( requestedModel );
                const url = `${proxy.normalizeBaseUrl( config.baseUrl )}/chat/completions`;
                const upstreamRequest = proxy.withReasoningEffort( request, body, config, request?.model ?? requestedModel );
                const upstreamRequestStartedAt = Date.now();
                const response = await proxy.fetchWithProxy( url, {
                    method: 'POST',
                    headers: proxy.buildHeaders( config ),
                    body: JSON.stringify( upstreamRequest ),
                } );
                const upstreamResponseReceivedAt = Date.now();
                const payload = await proxy.parseResponsePayload( response );
                if ( !response.ok ) {
                    const error = new Error( `Upstream request failed with ${response.status}` );
                    ( error as any ).status = response.status;
                    ( error as any ).payload = payload;
                    throw error;
                }
                console.info( `[messages] code_interpreter_upstream provider=${config.id} model=${requestedModel} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt} totalMs=${upstreamResponseReceivedAt - requestStartedAt}` );
                return { response, payload };
            },
            proxy.calculateTokenCount.bind( proxy ),
            proxy.rateLimitManager,
            proxy.buildCodeInterpreterSessionId() // sessionId: 7th arg
        );
        const totalMs = Date.now() - requestStartedAt;
        const serverTiming = proxy.formatTimingEntries( {
            body_parse: bodyParsedAt - requestStartedAt,
            web_search: webSearchCompletedAt - requestStartedAt,
            total: totalMs,
        } );
        if ( serverTiming ) {
            c.header( 'Server-Timing', serverTiming );
        }
        console.info( `[messages] success provider=code_interpreter model=${requestedModel} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} totalMs=${totalMs}` );
        return { handled: true, response: c.json( toolRunResult.payload, 200 ) };
    } catch ( error: any ) {
        return {
            handled: true,
            failure: {
                status: error?.status ?? 502,
                payload: error?.payload ?? {
                    error: {
                        message: error?.message || 'Upstream request failed',
                        type: 'invalid_request_error',
                    },
                },
            },
        };
    }
}
