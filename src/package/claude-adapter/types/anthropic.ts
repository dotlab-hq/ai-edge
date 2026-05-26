export interface AnthropicMessageRequest {
    model: string;
    messages: AnthropicMessage[];
    system?: string | AnthropicSystemContent[];
    max_tokens: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    stream?: boolean;
    tools?: AnthropicToolDefinition[];
    tool_choice?: AnthropicToolChoice;
    metadata?: {
        user_id?: string;
    };
}

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
    _gemini?: {
        parts?: unknown[];
    };
}

export interface AnthropicSystemContent {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
    };
}

export type AnthropicContentBlock =
    | AnthropicTextBlock
    | AnthropicThinkingBlock
    | AnthropicImageBlock
    | AnthropicFileBlock
    | AnthropicAudioBlock
    | AnthropicToolUseBlock
    | AnthropicToolResultBlock;

export interface AnthropicTextBlock {
    type: 'text';
    text: string;
}

export interface AnthropicThinkingBlock {
    type: 'thinking';
    thinking: string;
    signature?: string;
    _provider_state?: {
        google?: {
            parts?: unknown[];
            thought_signature?: string;
        };
    };
}

export interface AnthropicImageBlock {
    type: 'image';
    source?: AnthropicMediaSource;
}

export interface AnthropicFileBlock {
    type: 'file';
    source?: AnthropicMediaSource;
}

export interface AnthropicAudioBlock {
    type: 'audio';
    source?: AnthropicMediaSource;
}

export type AnthropicMediaSource =
    | { type: 'base64'; media_type?: string; data: string }
    | { type: 'url'; url: string }
    | { type: 'file'; file_id: string }
    | Record<string, unknown>;

export interface AnthropicToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
    _google?: {
        thought_signature?: string;
        raw_parts?: unknown[];
    };
}

export interface AnthropicToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content: string | AnthropicContentBlock[];
    is_error?: boolean;
}

export interface AnthropicToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export interface AnthropicToolChoice {
    type: 'auto' | 'any' | 'tool';
    name?: string;
}

export interface AnthropicMessageResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    stop_sequence: string | null;
    usage: AnthropicUsage;
    _gemini?: {
        parts?: unknown[];
    };
}

export interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

