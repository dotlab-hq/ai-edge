import { randomBytes } from 'crypto';
import type {
    AnthropicMessageResponse,
    OpenAIStreamChunk,
} from '@/package/claude-adapter';

export type StreamWriter = {
    write: ( chunk: string ) => Promise<unknown>;
    writeln?: ( chunk: string ) => Promise<unknown>;
};

export type SseOut = string[];

export interface StreamToolCallState {
    id: string;
    name: string;
    arguments: string;
    blockIndex: number;
}

export interface StreamState {
    messageId: string;
    model: string;
    responseModel: string;
    contentBlockIndex: number;
    initialContentBlocks: Array<Record<string, any>>;
    initialContentBlocksEmitted: boolean;
    serverToolUseCount: number;
    currentToolCalls: Map<number, StreamToolCallState>;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    hasStarted: boolean;
    textContent: string;
    textBlockOpen: boolean;
    reasoningEmittedStart: boolean;
    reasoningEmittedEnd: boolean;
    reasoningBlockOpen: boolean;
    reasoningSignature?: string;
    openBlockTypes: Map<number, 'text' | 'thinking' | 'tool_use' | 'server_tool_use'>;
    lastFinishReason: OpenAIStreamChunk['choices'][number]['finish_reason'] | null;
    finished: boolean;
    streamStartedAt: number;
    firstSseEmissionLogged: boolean;
}

let toolIdCounter = 0;

export function generateUniqueToolId(): string {
    toolIdCounter++;
    const timestamp = Date.now().toString( 36 );
    const counter = toolIdCounter.toString( 36 ).padStart( 4, '0' );
    const random = Math.random().toString( 36 ).substring( 2, 10 );
    return `call_${timestamp}_${counter}_${random}`;
}

export function getOrCreateThinkingSignature( state: StreamState ): string {
    if ( state.reasoningSignature ) {
        return state.reasoningSignature;
    }

    const signature = randomBytes( 32 ).toString( 'base64' );
    state.reasoningSignature = signature;
    return signature;
}

export function mapStopReason( reason: OpenAIStreamChunk['choices'][number]['finish_reason'] | null ): AnthropicMessageResponse['stop_reason'] {
    switch ( reason ) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        case 'content_filter':
            return 'end_turn';
        default:
            return 'end_turn';
    }
}
