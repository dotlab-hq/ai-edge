/**
 * Gemini API request format (generative-content-api)
 */
export interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}

export interface GeminiPart {
    text?: string;
    functionCall?: {
        name: string;
        args: Record<string, unknown>;
        thought_signature?: string;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
}

export interface GeminiRequest {
    model: string;
    contents: GeminiContent[];
    systemInstruction?: string | { parts: GeminiPart[] };
    tools?: GeminiTool[];
    toolConfig?: {
        functionCallingConfig: {
            mode: 'AUTO' | 'ANY' | 'NONE';
            allowedFunctionNames?: string[];
        };
    };
    generationConfig?: {
        temperature?: number;
        topP?: number;
        topK?: number;
        maxOutputTokens?: number;
        stopSequences?: string[];
    };
}

export interface GeminiTool {
    functionDeclarations?: Array<{
        name: string;
        description?: string;
        parameters?: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    }>;
}

export const FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
