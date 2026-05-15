import { fetch as undiciFetch, ProxyAgent } from 'undici';

const proxyAgentCache = new Map<string, ProxyAgent>();
const DEFAULT_TIMEOUT_MS = 45_000;

function getEnvProxyUrl(): string | undefined {
    return process.env.HTTPS_PROXY
        ?? process.env.https_proxy
        ?? process.env.HTTP_PROXY
        ?? process.env.http_proxy
        ?? process.env.ALL_PROXY
        ?? process.env.all_proxy;
}

function normalizeProxyUrl( proxyUrl?: string ): string | undefined {
    const trimmed = proxyUrl?.trim();
    if ( trimmed ) {
        return trimmed;
    }

    const envProxyUrl = getEnvProxyUrl()?.trim();
    return envProxyUrl || undefined;
}

function getProxyAgent( proxyUrl: string ): ProxyAgent {
    const cachedAgent = proxyAgentCache.get( proxyUrl );
    if ( cachedAgent ) {
        return cachedAgent;
    }

    const agent = new ProxyAgent( proxyUrl );
    proxyAgentCache.set( proxyUrl, agent );
    return agent;
}

function getConfiguredTimeoutMs(): number {
    const raw = process.env.AI_EDGE_UPSTREAM_TIMEOUT_MS?.trim();
    if ( !raw ) {
        return DEFAULT_TIMEOUT_MS;
    }

    const parsed = Number( raw );
    if ( !Number.isFinite( parsed ) || parsed <= 0 ) {
        return DEFAULT_TIMEOUT_MS;
    }

    return Math.trunc( parsed );
}

type FetchInput = Parameters<typeof undiciFetch>[0];

type ProxyAwareFetch = ( input: FetchInput, init?: RequestInit ) => Promise<Response>;

const proxyAwareFetch = undiciFetch as unknown as ProxyAwareFetch;

export async function fetchWithProxy( input: FetchInput, init?: RequestInit, proxyUrl?: string ): Promise<Response> {
    const resolvedProxyUrl = normalizeProxyUrl( proxyUrl );
    const timeoutMs = getConfiguredTimeoutMs();
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
            return await proxyAwareFetch( input, {
                ...init,
                signal: controller.signal,
            } );
        }

        const dispatcher = getProxyAgent( resolvedProxyUrl );
        return await proxyAwareFetch( input, {
            ...init,
            signal: controller.signal,
            dispatcher,
        } as RequestInit & { dispatcher?: ProxyAgent } );
    } finally {
        if ( timeoutId ) {
            clearTimeout( timeoutId );
        }
    }
}