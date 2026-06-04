import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import http from 'node:http';

const proxyAgentCache = new Map<string, ProxyAgent>();
const originAgentCache = new Map<string, Agent>();
const DEFAULT_TIMEOUT_MS = 180_000;        // 3 min (was 45s — too short for large LLM responses)
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 120_000;
const DEFAULT_KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_CONNECTIONS_PER_ORIGIN = 16;
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100;
const KEEP_ALIVE_ENABLE_MS = 30_000;

// Start periodic cleanup of agent caches
const cleanupTimer = setInterval( cleanupAgentCaches, CACHE_CLEANUP_INTERVAL_MS );
cleanupTimer.unref?.();

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

function getOriginFromInput( input: FetchInput ): string | undefined {
    return getUrlFromInput( input )?.origin;
}

function getOriginAgent( origin: string ): Agent {
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

function getConfiguredPositiveInt( envName: string, fallback: number ): number {
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

type FetchInput = Parameters<typeof undiciFetch>[0];

type ProxyAwareFetch = ( input: FetchInput, init?: RequestInit ) => Promise<Response>;

type FetchWithProxyOptions = {
    skipTimeout?: boolean;
};

const proxyAwareFetch = undiciFetch as unknown as ProxyAwareFetch;

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
            } as RequestInit & { dispatcher?: Agent } );
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
        } as RequestInit & { dispatcher?: Dispatcher } );
        await response.body?.cancel().catch( () => undefined );
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout( timeoutId );
    }
}

export function getUpstreamConnectionPoolStats(): Record<string, unknown> {
    return {
        directOrigins: Array.from( originAgentCache.keys() ),
        proxyUrls: Array.from( proxyAgentCache.keys() ),
    };
}

function cleanupAgentCaches(): void {
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

function getDispatcherForInput( input: FetchInput, proxyUrl?: string ): Dispatcher | undefined {
    const resolvedProxyUrl = normalizeProxyUrl( proxyUrl );
    if ( resolvedProxyUrl ) {
        return getProxyAgent( resolvedProxyUrl );
    }

    const origin = getOriginFromInput( input );
    return origin ? getOriginAgent( origin ) : undefined;
}

function getUrlFromInput( input: FetchInput ): URL | undefined {
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

type NodeRequestListener = ( req: http.IncomingMessage, res: http.ServerResponse ) => void;

function wrapNoDelayListener( requestListener?: NodeRequestListener ): NodeRequestListener | undefined {
    if ( !requestListener ) {
        return undefined;
    }

    return ( req, res ) => {
        const socket = res.socket;
        if ( socket ) {
            socket.setNoDelay( true );
            socket.setKeepAlive( true, KEEP_ALIVE_ENABLE_MS );
        }
        requestListener( req, res );
    };
}

export function createNodeServerWithNoDelay( requestListener?: NodeRequestListener ): http.Server {
    return http.createServer( wrapNoDelayListener( requestListener ) );
}

export function createNodeServerFactoryWithNoDelay(): typeof http.createServer {
    const factory = ( ( ...args: any[] ) => {
        if ( typeof args[0] === 'function' || args.length === 0 ) {
            return http.createServer( wrapNoDelayListener( args[0] as NodeRequestListener | undefined ) );
        }

        const requestListener = typeof args[1] === 'function'
            ? wrapNoDelayListener( args[1] as NodeRequestListener )
            : undefined;
        return http.createServer( args[0], requestListener );
    } ) as unknown as typeof http.createServer;
    return factory;
}
