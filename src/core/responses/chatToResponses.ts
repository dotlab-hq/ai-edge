import type { ChatCompletionResponse, ResponsesRequest, ResponsesOutputItem } from './types';
import type { FileSearchCallItem } from './types';
import { generateId, buildEmptyUsage } from './helpers';

export function convertChatResponseToResponses(
    chatResponse: ChatCompletionResponse,
    originalRequest: ResponsesRequest,
    fileSearchCalls?: FileSearchCallItem[],
): Record<string, unknown> {
    const choice = chatResponse.choices?.[0];
    const message = choice?.message;

    const output: ResponsesOutputItem[] = [];

    // File search call output items (prepend before other items)
    if ( Array.isArray( fileSearchCalls ) ) {
        for ( const fsc of fileSearchCalls ) {
            output.push( {
                type: 'file_search_call',
                id: fsc.id,
                status: fsc.status,
                queries: fsc.queries,
                ...( fsc.results ? { results: fsc.results } : {} ),
            } as ResponsesOutputItem );
        }
    }

    // Tool calls → function_call output items
    if ( Array.isArray( message?.tool_calls ) ) {
        for ( const tc of message.tool_calls as Array<Record<string, unknown>> ) {
            const fn = tc.function as Record<string, unknown> | undefined;
            output.push( {
                type: 'function_call',
                id: tc.id as string || generateId( 'fc' ),
                call_id: tc.id as string || generateId( 'call' ),
                name: fn?.name ?? '',
                arguments: fn?.arguments ?? '{}',
            } );
        }
    }

    // Text content → message output item
    const textContent = message?.content;
    if ( textContent && typeof textContent === 'string' ) {
        output.push( {
            type: 'message',
            id: generateId( 'msg' ),
            role: 'assistant',
            status: 'completed',
            content: [{
                type: 'output_text',
                text: textContent,
                annotations: [],
            }],
        } );
    } else if ( !message?.tool_calls?.length ) {
        // When there's no text content but reasoning is present (model spent
        // all its budget on reasoning), surface it as a reasoning item so
        // the output array is never empty.
        const reasoningText = ( message as any )?.reasoning_content
            || ( message as any )?.reasoning
            || ( message as any )?.thinking;
        output.push( {
            type: 'reasoning',
            id: generateId( 'rs' ),
            summary: reasoningText
                ? [{ type: 'summary_text', text: reasoningText }]
                : [],
        } );
    }

    const usage = chatResponse.usage
        ? {
            input_tokens: chatResponse.usage.prompt_tokens ?? 0,
            input_tokens_details: {
                cached_tokens: chatResponse.usage.prompt_tokens_details?.cached_tokens ?? 0,
            },
            output_tokens: chatResponse.usage.completion_tokens ?? 0,
            output_tokens_details: {
                reasoning_tokens: chatResponse.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            },
            total_tokens: chatResponse.usage.total_tokens
                ?? ( ( chatResponse.usage.prompt_tokens ?? 0 ) + ( chatResponse.usage.completion_tokens ?? 0 ) ),
        }
        : buildEmptyUsage();

    return {
        id: generateId( 'resp' ),
        object: 'response',
        created: chatResponse.created ?? Math.floor( Date.now() / 1000 ),
        model: originalRequest.model,
        output,
        usage,
        status: 'completed',
    };
}
