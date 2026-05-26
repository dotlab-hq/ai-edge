import type { AnthropicMessageResponse, AnthropicToolUseBlock } from '../types/anthropic';
import type { OpenAIChatResponse, OpenAIToolCall } from '../types/openai';

/**
 * Convert OpenAI Chat Completion response to Anthropic Messages format.
 */
export function convertResponseToAnthropic(
    openaiResponse: OpenAIChatResponse,
    originalModelRequested: string
): AnthropicMessageResponse {
    const choice = openaiResponse.choices[0];
    if ( !choice ) {
        throw new Error( 'OpenAI response did not contain a choice' );
    }

    const message = choice.message;
    const content: AnthropicMessageResponse['content'] = [];
    const reasoning = message.reasoning || message.reasoning_content;

    if ( reasoning ) {
        content.push( {
            type: 'thinking',
            thinking: reasoning,
            ...( message.reasoning_signature ? { signature: message.reasoning_signature } : {} ),
        } );
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

    return {
        id: `msg_${openaiResponse.id}`,
        type: 'message',
        role: 'assistant',
        content,
        model: originalModelRequested,
        stop_reason: mapFinishReason( choice.finish_reason ),
        stop_sequence: null,
        usage,
    };
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

    return {
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input,
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
