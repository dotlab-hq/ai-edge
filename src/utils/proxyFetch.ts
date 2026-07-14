import { proxyAwareFetch, getConfiguredTimeoutMs, normalizeProxyUrl, getOriginFromInput, getOriginAgent, getProxyAgent, type FetchInput, type ProxyAwareFetch, type FetchWithProxyOptions } from './proxyHelpers';

/**
 * Fetch a URL using a configured proxy (env or explicit) with a per-request
 * timeout and abort handling. Falls back to a direct dispatcher agent when no
 * proxy is configured.
 */
export async function fetchWithProxy( input: FetchInput, init?: RequestInit, proxyUrl?: string, options?: FetchWithProxyOptions ): Promise<Response> {
    const resolvedProxyUrl = normalizeProxyUrl( proxyUrl );
    const timeoutMs = options?.skipTimeout ? 0 : getConfiguredTimeoutMs();
    const controller = new AbortController();
    const upstreamSignal = init?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if ( upstreamSignal ) {
        if ( upstreamSignal.aborted ) {
            controller.abort();
        } else {
            upstreamSignal.addEventListener( 'abort', () => controller.abort(), { once: true } );
        }
    }

    if ( timeoutMs > 0 ) {
        timeoutId = setTimeout( () => controller.abort(), timeoutMs );
    }

    try {
        if ( !resolvedProxyUrl ) {
            const origin = getOriginFromInput( input );
            const dispatcher = origin ? getOriginAgent( origin ) : undefined;
            return await proxyAwareFetch( input, {
                ...init,
                signal: controller.signal,
                ...( dispatcher ? { dispatcher } : {} ),
            } as RequestInit & { dispatcher?: ReturnType<typeof getOriginAgent> } );
        }

        const dispatcher = getProxyAgent( resolvedProxyUrl );
        return await proxyAwareFetch( input, {
            ...init,
            signal: controller.signal,
            dispatcher,
        } as RequestInit & { dispatcher?: ReturnType<typeof getProxyAgent> } );
    } finally {
        if ( timeoutId ) {
            clearTimeout( timeoutId );
        }
    }
}

export { warmUpstreamConnection } from './proxyWarmup';
export { getUpstreamConnectionPoolStats } from './proxyHelpers';
export { createNodeServerWithNoDelay, createNodeServerFactoryWithNoDelay } from './proxyServer';
export type { FetchInput, ProxyAwareFetch, FetchWithProxyOptions } from './proxyHelpers';
