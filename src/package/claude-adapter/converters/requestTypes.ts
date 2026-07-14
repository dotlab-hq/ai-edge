import type { AnthropicContentBlock } from '../types/anthropic';
import type {
    OpenAIMessage,
    OpenAIToolCall,
    OpenAIToolMessage,
    OpenAIUserContentPart,
} from '../types/openai';

export interface ToolIdDeduplicationContext {
    seenIds: Set<string>;
    idMappings: Map<string, string[]>;
    resultIndex: Map<string, number>;
}

export interface UserContentResult {
    userContent: OpenAIUserContentPart[];
    toolResults: OpenAIToolMessage[];
}

export interface AssistantContentResult {
    textContent: string;
    toolCalls: OpenAIToolCall[];
}

export function createDedupeContext(): ToolIdDeduplicationContext {
    return {
        seenIds: new Set<string>(),
        idMappings: new Map<string, string[]>(),
        resultIndex: new Map<string, number>(),
    };
}
