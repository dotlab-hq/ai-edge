import type { ResponsesStreamState } from './types';
import { generateId } from './helpers';
import { emitResponsesEvent } from './streamState';

/**
 * Emit a single `response.completed` event with the full output list.
 */
export function emitResponsesCompleted( state: ResponsesStreamState, out: string[] ): void {
    emitResponsesEvent( out, 'response.completed', {
        type: 'response.completed',
        response: buildResponsesCompletedResponse( state ),
    } );
}

/**
 * Build the complete `response` object (same shape as response.completed)
 * from stream state. Reused by the GET /v1/responses/{id} endpoint so a
 * re-fetched response is byte-identical to the streamed one.
 */
export function buildResponsesCompletedResponse( state: ResponsesStreamState ): any {
    const output = buildResponsesOutput( state );

    let outputTokens = state.outputTokens;
    let inputTokens = state.inputTokens;
    if ( inputTokens === 0 && outputTokens === 0 ) {
        const outputText = state.textItems.reduce( ( acc, ti ) => acc + ( ti.text ?? '' ), '' );
        const toolCallText = state.toolCalls.reduce( ( acc, tc ) => acc + ( tc.arguments ?? '' ), '' );
        outputTokens = Math.max( 1, Math.ceil( ( outputText.length + toolCallText.length ) / 4 ) );
        inputTokens = Math.max( 1, Math.ceil( outputTokens * 0.3 ) );
    }

    return {
        id: state.responseId,
        object: 'response',
        status: 'completed',
        created: state.created,
        model: state.model,
        output,
        usage: {
            input_tokens: inputTokens,
            input_tokens_details: { cached_tokens: state.cachedInputTokens },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: state.reasoningTokens },
            total_tokens: inputTokens + outputTokens,
        },
    };
}

function buildResponsesOutput( state: ResponsesStreamState ): any[] {
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

    if ( state.textItems.length === 0 && state.reasoningItems.length > 0 ) {
        const summaryText = state.reasoningItems.map( ( r ) => r.text ).join( '\n' ).trim()
            || 'Reasoning completed. No final output was produced.';
        output.push( {
            type: 'message',
            id: generateId( 'msg' ),
            role: 'assistant',
            status: 'completed',
            content: [ { type: 'output_text', text: summaryText, annotations: [] } ],
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

    if ( output.length === 0 ) {
        output.push( {
            type: 'message',
            id: generateId( 'msg' ),
            role: 'assistant',
            status: 'completed',
            content: [],
        } );
    }

    return output;
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
