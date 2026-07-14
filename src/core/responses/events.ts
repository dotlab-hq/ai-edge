import type { ResponsesStreamState } from './types';
import { generateId } from './helpers';
import { emitResponsesEvent } from './streamState';

/**
 * Build the full output items list from stream state (text items + tool calls)
 * and emit a single `response.completed` event.
 */
export function emitResponsesCompleted( state: ResponsesStreamState, out: string[] ): void {
    const output: any[] = [];

    // File search call output items (before text items)
    for ( const fsc of state.fileSearchCalls ) {
        output.push( {
            type: 'file_search_call',
            id: fsc.id,
            status: fsc.status,
            queries: fsc.queries,
            ...( fsc.results ? { results: fsc.results } : {} ),
        } );
    }

    // Reasoning output items
    for ( const ri of state.reasoningItems ) {
        output.push( {
            type: 'reasoning',
            id: ri.itemId,
            summary: ri.text
                ? [ { type: 'summary_text', text: ri.text } ]
                : [],
        } );
    }

    // Text output items
    for ( const ti of state.textItems ) {
        output.push( {
            type: 'message',
            id: ti.itemId,
            role: 'assistant',
            status: 'completed',
            content: ti.text
                ? [ { type: 'output_text', text: ti.text, annotations: [] } ]
                : [],
        } );
    }

    // Tool call output items
    for ( const tc of state.toolCalls ) {
        output.push( {
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
        } );
    }

    // Fallback: when there's no message or reasoning output, emit a minimal
    // message so the response always has content.
    if ( output.length === 0 ) {
        output.push( {
            type: 'message',
            id: generateId( 'msg' ),
            role: 'assistant',
            status: 'completed',
            content: [],
        } );
    }

    // ── Fallback: estimate token counts when upstream didn't provide usage ──
    let inputTokens = state.inputTokens;
    let outputTokens = state.outputTokens;
    let cachedInputTokens = state.cachedInputTokens;
    let reasoningTokens = state.reasoningTokens;

    if ( inputTokens === 0 && outputTokens === 0 ) {
        const outputText = state.textItems.reduce( ( acc, ti ) => acc + ( ti.text ?? '' ), '' );
        const toolCallText = state.toolCalls.reduce( ( acc, tc ) => acc + ( tc.arguments ?? '' ), '' );
        outputTokens = Math.max( 1, Math.ceil( ( outputText.length + toolCallText.length ) / 4 ) );

        inputTokens = Math.max( 1, Math.ceil( outputTokens * 0.3 ) );

        console.info(
            `[responses] usage_fallback估算 token counts from content `
            + `outputTextLen=${outputText.length} toolCallArgLen=${toolCallText.length} `
            + `estimated_output_tokens=${outputTokens} estimated_input_tokens=${inputTokens}`,
        );
    }

    emitResponsesEvent( out, 'response.completed', {
        type: 'response.completed',
        response: {
            id: state.responseId,
            object: 'response',
            status: 'completed',
            created: state.created,
            model: state.model,
            output,
            usage: {
                input_tokens: inputTokens,
                input_tokens_details: { cached_tokens: cachedInputTokens },
                output_tokens: outputTokens,
                output_tokens_details: { reasoning_tokens: reasoningTokens },
                total_tokens: inputTokens + outputTokens,
            },
        },
    } );
}

/**
 * Build the full output items list from stream state (text items + tool calls).
 * Used by callers that need the output array for caching without emitting events.
 */
export function buildStreamOutputItems( state: ResponsesStreamState ): any[] {
    const output: any[] = [];
    for ( const fsc of state.fileSearchCalls ) {
        output.push( {
            type: 'file_search_call',
            id: fsc.id,
            status: fsc.status,
            queries: fsc.queries,
            ...( fsc.results ? { results: fsc.results } : {} ),
        } );
    }
    for ( const ri of state.reasoningItems ) {
        output.push( {
            type: 'reasoning',
            id: ri.itemId,
            summary: ri.text
                ? [ { type: 'summary_text', text: ri.text } ]
                : [],
        } );
    }
    for ( const ti of state.textItems ) {
        output.push( {
            type: 'message',
            id: ti.itemId,
            role: 'assistant',
            status: 'completed',
            content: ti.text
                ? [ { type: 'output_text', text: ti.text, annotations: [] } ]
                : [],
        } );
    }
    for ( const tc of state.toolCalls ) {
        output.push( {
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
        } );
    }
    return output;
}
