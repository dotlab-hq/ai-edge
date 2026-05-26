import { randomBytes } from 'crypto';
import type { AnthropicMessageResponse, AnthropicToolUseBlock } from '../types/anthropic';
import type { OpenAIChatResponse, OpenAIToolCall } from '../types/openai';

/**
 * Extract Gemini's native parts array if available in the response metadata.
 * This handles responses that came from Gemini backends and were transformed to OpenAI format.
 */
export function extractGeminiPartsFromResponse( openaiResponse: any ): unknown[] | undefined {
    // Check if response contains Gemini parts metadata (set by upstream transformation)
    if ( openaiResponse._gemini?.parts && Array.isArray( openaiResponse._gemini.parts ) ) {
        return openaiResponse._gemini.parts;
    }

    // Check in choice message
    if ( openaiResponse.choices?.[0]?.message?._gemini?.parts ) {
        return openaiResponse.choices[0].message._gemini.parts;
    }

    return undefined;
}

/**
 * Convert OpenAI Chat Completion response to Anthropic Messages format.
 * Embeds Gemini's native contents.parts in thinking blocks for lossless replay.
 */
export function convertResponseToAnthropic(
    openaiResponse: OpenAIChatResponse,
    originalModelRequested: string,
    geminiParts?: unknown[]
): AnthropicMessageResponse {
    const choice = openaiResponse.choices[0];
    if ( !choice ) {
        throw new Error( 'OpenAI response did not contain a choice' );
    }

    const message = choice.message;
    const content: AnthropicMessageResponse['content'] = [];
    const reasoning = message.reasoning || message.reasoning_content;

    // Embed Gemini parts in thinking block if available
    const partsToAttach = geminiParts || extractGeminiPartsFromResponse( openaiResponse );

    if ( reasoning ) {
        const signature = message.reasoning_signature || randomBytes( 32 ).toString( 'base64' );
        const thinkingBlock: any = {
            type: 'thinking',
            thinking: reasoning,
            signature,
        };

        // Attach Gemini provider state to thinking block for exact reconstruction
        if ( partsToAttach && partsToAttach.length > 0 ) {
            thinkingBlock._provider_state = {
                google: {
                    parts: partsToAttach,
                },
            };
        }

        content.push( thinkingBlock );
    }

    if ( message.content ) {
        content.push( {
            type: 'text',
            text: message.content,
        } );
    }

    if ( message.tool_calls && message.tool_calls.length > 0 ) {
        for ( const toolCall of message.tool_calls ) {
            content.push( convertToolCallToToolUse( toolCall ) );
        }
    }

    const usage = {
        input_tokens: openaiResponse.usage.prompt_tokens,
        output_tokens: openaiResponse.usage.completion_tokens,
        cache_read_input_tokens: openaiResponse.usage.prompt_tokens_details?.cached_tokens,
    };

    const response: AnthropicMessageResponse = {
        id: `msg_${openaiResponse.id}`,
        type: 'message',
        role: 'assistant',
        content,
        model: originalModelRequested,
        stop_reason: mapFinishReason( choice.finish_reason ),
        stop_sequence: null,
        usage,
    };

    return response;
}

/**
 * Create an error response in Anthropic format.
 */
export function createErrorResponse( error: Error, statusCode = 500 ): { error: { type: string; message: string }; status: number } {
    return {
        error: {
            type: mapErrorType( statusCode ),
            message: error.message,
        },
        status: statusCode,
    };
}

function convertToolCallToToolUse( toolCall: OpenAIToolCall ): AnthropicToolUseBlock {
    let input: Record<string, unknown>;
    try {
        input = JSON.parse( toolCall.function.arguments ) as Record<string, unknown>;
    } catch {
        input = { raw: toolCall.function.arguments };
    }

    const FALLBACK_SIG = 'skip_thought_signature_validator';
    const tc = toolCall as any;
    const thoughtSignature = tc.thought_signature
        || tc.extra_content?.google?.thought_signature
        || tc.function?.thought_signature
        || FALLBACK_SIG;

    return {
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input,
        _google: {
            thought_signature: thoughtSignature,
        },
    };
}

function mapFinishReason( finishReason: OpenAIChatResponse['choices'][number]['finish_reason'] ): AnthropicMessageResponse['stop_reason'] {
    if ( !finishReason ) {
        return null;
    }

    switch ( finishReason ) {
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

function mapErrorType( statusCode: number ): string {
    switch ( statusCode ) {
        case 400:
            return 'invalid_request_error';
        case 401:
            return 'authentication_error';
        case 403:
            return 'permission_error';
        case 404:
            return 'not_found_error';
        case 429:
            return 'rate_limit_error';
        case 500:
        default:
            return 'api_error';
    }
}
