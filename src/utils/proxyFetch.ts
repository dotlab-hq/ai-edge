import { fetch as undiciFetch, ProxyAgent } from 'undici';

const proxyAgentCache = new Map<string, ProxyAgent>();

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

type FetchInput = Parameters<typeof undiciFetch>[0];

type ProxyAwareFetch = ( input: FetchInput, init?: RequestInit ) => Promise<Response>;

const proxyAwareFetch = undiciFetch as unknown as ProxyAwareFetch;

export async function fetchWithProxy( input: FetchInput, init?: RequestInit, proxyUrl?: string ): Promise<Response> {
    const resolvedProxyUrl = normalizeProxyUrl( proxyUrl );

    if ( !resolvedProxyUrl ) {
        return proxyAwareFetch( input, init );
    }

    const dispatcher = getProxyAgent( resolvedProxyUrl );
    return proxyAwareFetch( input, {
        ...init,
        dispatcher,
    } as RequestInit & { dispatcher?: ProxyAgent } );
}