import { getConfiguredPositiveInt, getDispatcherForInput, getUrlFromInput, proxyAwareFetch, type FetchInput } from './proxyHelpers';

export async function warmUpstreamConnection( input: FetchInput, proxyUrl?: string ): Promise<boolean> {
    const dispatcher = getDispatcherForInput( input, proxyUrl );
    const url = getUrlFromInput( input );
    if ( !dispatcher || !url ) {
        return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout( () => controller.abort(), getConfiguredPositiveInt( 'AI_EDGE_UPSTREAM_WARMUP_TIMEOUT_MS', 3_000 ) );

    try {
        const response = await proxyAwareFetch( url.href, {
            method: 'HEAD',
            signal: controller.signal,
            dispatcher,
        } as any );
        await response.body?.cancel().catch( () => undefined );
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout( timeoutId );
    }
}
