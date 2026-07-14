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
}

export interface WSConnection {
    ws: WebSocket;
    alive: boolean;
    timer: NodeJS.Timeout;
    queuedMessages: any[];
    inFlight: boolean;
    responseCache: Map<string, CachedResponse>;
}
