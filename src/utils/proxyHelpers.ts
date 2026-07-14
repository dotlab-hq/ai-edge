import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';

const proxyAgentCache = new Map<string, ProxyAgent>();
const originAgentCache = new Map<string, Agent>();
const DEFAULT_TIMEOUT_MS = 180_000;        // 3 min (was 45s -- too short for large LLM responses)
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 120_000;
const DEFAULT_KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_CONNECTIONS_PER_ORIGIN = 4;
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 16;

// Start periodic cleanup of agent caches
const cleanupTimer = setInterval( cleanupAgentCaches, CACHE_CLEANUP_INTERVAL_MS );
cleanupTimer.unref?.();

export type FetchInput = Parameters<typeof undiciFetch>[0];

export type ProxyAwareFetch = ( input: FetchInput, init?: RequestInit ) => Promise<Response>;

export type FetchWithProxyOptions = {
    skipTimeout?: boolean;
};

export const proxyAwareFetch = undiciFetch as unknown as ProxyAwareFetch;

export function getEnvProxyUrl(): string | undefined {
    return process.env.HTTPS_PROXY
        ?? process.env.https_proxy
        ?? process.env.HTTP_PROXY
        ?? process.env.http_proxy
        ?? process.env.ALL_PROXY
        ?? process.env.all_proxy;
}

export function normalizeProxyUrl( proxyUrl?: string ): string | undefined {
    const trimmed = proxyUrl?.trim();
    if ( trimmed ) {
        return trimmed;
    }

    const envProxyUrl = getEnvProxyUrl()?.trim();
    return envProxyUrl || undefined;
}

export function getProxyAgent( proxyUrl: string ): ProxyAgent {
    const cachedAgent = proxyAgentCache.get( proxyUrl );
    if ( cachedAgent ) {
        return cachedAgent;
    }

    const agent = new ProxyAgent( proxyUrl );
    proxyAgentCache.set( proxyUrl, agent );
    return agent;
}

export function getOriginFromInput( input: FetchInput ): string | undefined {
    return getUrlFromInput( input )?.origin;
}

export function getOriginAgent( origin: string ): Agent {
    const cachedAgent = originAgentCache.get( origin );
    if ( cachedAgent ) {
        return cachedAgent;
    }

    const agent = new Agent( {
        connections: getConfiguredPositiveInt( 'AI_EDGE_UPSTREAM_CONNECTIONS_PER_ORIGIN', DEFAULT_CONNECTIONS_PER_ORIGIN ),
        connectTimeout: getConfiguredPositiveInt( 'AI_EDGE_UPSTREAM_CONNECT_TIMEOUT_MS', 10_000 ),
        headersTimeout: getConfiguredPositiveInt( 'AI_EDGE_UPSTREAM_HEADERS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS ),
        bodyTimeout: 0,
        keepAliveTimeout: getConfiguredPositiveInt( 'AI_EDGE_UPSTREAM_KEEP_ALIVE_TIMEOUT_MS', DEFAULT_KEEP_ALIVE_TIMEOUT_MS ),
        keepAliveMaxTimeout: getConfiguredPositiveInt( 'AI_EDGE_UPSTREAM_KEEP_ALIVE_MAX_TIMEOUT_MS', DEFAULT_KEEP_ALIVE_MAX_TIMEOUT_MS ),
        keepAliveTimeoutThreshold: getConfiguredPositiveInt( 'AI_EDGE_UPSTREAM_KEEP_ALIVE_THRESHOLD_MS', 30_000 ),
        pipelining: 1,
        allowH2: true,
    } );
    originAgentCache.set( origin, agent );
    return agent;
}

export function getConfiguredTimeoutMs(): number {
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

export function getConfiguredPositiveInt( envName: string, fallback: number ): number {
    const raw = process.env[envName]?.trim();
    if ( !raw ) {
        return fallback;
    }

    const parsed = Number( raw );
    if ( !Number.isFinite( parsed ) || parsed <= 0 ) {
        return fallback;
    }

    return Math.trunc( parsed );
}

export function cleanupAgentCaches(): void {
    // Simple cleanup - in a production system, we might want to use LRU or similar
    if ( originAgentCache.size > MAX_CACHE_SIZE ) {
        // Clear half of the cache when it gets too large
        const keysToRemove = Array.from( originAgentCache.keys() ).slice( 0, Math.floor( originAgentCache.size / 2 ) );
        for ( const key of keysToRemove ) {
            const agent = originAgentCache.get( key );
            if ( agent ) {
                // Agent doesn't have a close method, but we remove reference
                originAgentCache.delete( key );
            }
        }
    }

    if ( proxyAgentCache.size > MAX_CACHE_SIZE ) {
        // Clear half of the cache when it gets too large
        const keysToRemove = Array.from( proxyAgentCache.keys() ).slice( 0, Math.floor( proxyAgentCache.size / 2 ) );
        for ( const key of keysToRemove ) {
            const agent = proxyAgentCache.get( key );
            if ( agent ) {
                // Close the proxy agent properly
                try {
                    // ProxyAgent doesn't have a close method in undici, but we remove reference
                    proxyAgentCache.delete( key );
                } catch ( e ) {
                    // Ignore errors during cleanup
                    proxyAgentCache.delete( key );
                }
            }
        }
    }
}

export function getDispatcherForInput( input: FetchInput, proxyUrl?: string ): Dispatcher | undefined {
    const resolvedProxyUrl = normalizeProxyUrl( proxyUrl );
    if ( resolvedProxyUrl ) {
        return getProxyAgent( resolvedProxyUrl );
    }

    const origin = getOriginFromInput( input );
    return origin ? getOriginAgent( origin ) : undefined;
}

export function getUrlFromInput( input: FetchInput ): URL | undefined {
    try {
        if ( typeof input === 'string' ) {
            return new URL( input );
        }
        if ( 'href' in input && typeof input.href === 'string' ) {
            return new URL( input.href );
        }
        if ( 'url' in input && typeof input.url === 'string' ) {
            return new URL( input.url );
        }
        return undefined;
    } catch {
        return undefined;
    }
}

export function getUpstreamConnectionPoolStats(): Record<string, unknown> {
    return {
        directOrigins: Array.from( originAgentCache.keys() ),
        proxyUrls: Array.from( proxyAgentCache.keys() ),
    };
}
