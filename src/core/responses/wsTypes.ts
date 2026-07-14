import type { WebSocket } from 'ws';

export const CONNECTION_MAX_MS = 60 * 60 * 1000; // 60 minutes
export const MAX_INPUT_TOKENS_BEFORE_COMPACT = 80_000;
export const MAX_INPUT_CHARS_BEFORE_COMPACT = MAX_INPUT_TOKENS_BEFORE_COMPACT * 4;
export const MAX_CONTEXT_MESSAGES = 80;

export interface CachedResponse {
    inputItems: any[];
    outputItems: any[];
    model: string;
    instructions?: string;
    responseId?: string;
    created?: number;
}

export interface WSConnection {
    ws: WebSocket;
    alive: boolean;
    missedPongs: number;
    queuedMessages: any[];
    inFlight: boolean;
    responseCache: Map<string, CachedResponse>;
}

// ponytail: global cache shared between the WS stream (writer) and the
// HTTP GET /v1/responses/{id} endpoint (reader), so a re-fetched response
// matches the streamed one. Per-conn cache stays for in-flight lookups.
export const globalResponseCache = new Map<string, CachedResponse>();
