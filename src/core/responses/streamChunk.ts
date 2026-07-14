import type { ResponsesStreamState } from './types';
import { generateId } from './helpers';
import {
    emitResponsesStreamPreamble,
    emitResponsesEvent,
    closeReasoningBlock,
    finishResponsesStream,
} from './streamState';

/**
 * Process one OpenAI chat completion SSE data chunk and emit corresponding
 * Responses-format SSE lines into `out`. Returns `true` when the stream is
 * complete (a `[DONE]` or `finish_reason` was encountered).
 */
export function processChatStreamChunkForResponses(
    chunk: Record<string, unknown> | null,
    state: ResponsesStreamState,
    out: string[],
): boolean {
    if ( state.finished ) return true;

    // Handle [DONE] sentinel
    if ( chunk === null ) {
        finishResponsesStream( state, out );
        return true;
    }

    // Accumulate usage from the final chunk
    const usage = chunk.usage as Record<string, number> | undefined;
    if ( usage ) {
        state.inputTokens = usage.prompt_tokens ?? state.inputTokens;
        state.outputTokens = usage.completion_tokens ?? state.outputTokens;
        const promptDetails = chunk.usage as any;
        state.cachedInputTokens = promptDetails?.prompt_tokens_details?.cached_tokens ?? state.cachedInputTokens;
        state.reasoningTokens = promptDetails?.completion_tokens_details?.reasoning_tokens ?? state.reasoningTokens;
    }

    // Emit response.created on first chunk
    emitResponsesStreamPreamble( state, out );

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if ( !choice ) {
        if ( usage ) {
            finishResponsesStream( state, out );
            return true;
        }
        return false;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    const finishReason = choice.finish_reason as string | undefined;

    // Handle text content
    if ( delta ) {
        // Handle reasoning content (DeepSeek sends delta.reasoning_content, others may use delta.reasoning/delta.thinking)
        const reasoningContent = ( delta.reasoning_content ?? delta.reasoning ?? delta.thinking ) as string | undefined;
        if ( typeof reasoningContent === 'string' && reasoningContent.length > 0 ) {
            if ( !state.currentReasoningBlockOpen ) {
                const itemId = generateId( 'reason' );
                state.reasoningItems.push( { itemId, text: reasoningContent } );
                emitResponsesEvent( out, 'response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: state.currentOutputIndex,
                    item: {
                        type: 'reasoning',
                        id: itemId,
                        summary: [],
                    },
                } );
                emitResponsesEvent( out, 'response.content_part.added', {
                    type: 'response.content_part.added',
                    output_index: state.currentOutputIndex,
                    content_index: state.contentBlockIndex,
                    part: { type: 'reasoning_summary', text: '' },
                } );
                state.currentReasoningBlockOpen = true;
            } else {
                const last = state.reasoningItems[state.reasoningItems.length - 1];
                if ( last ) last.text += reasoningContent;
            }

            emitResponsesEvent( out, 'response.reasoning_summary_text.delta', {
                type: 'response.reasoning_summary_text.delta',
                output_index: state.currentOutputIndex,
                content_index: state.contentBlockIndex,
                delta: reasoningContent,
            } );
        }

        const content = delta.content as string | undefined;

        if ( typeof content === 'string' && content.length > 0 ) {
            if ( !state.currentTextBlockOpen ) {
                closeReasoningBlock( state, out );
                const itemId = generateId( 'msg' );
                state.textItems.push( { itemId, text: content } );
                emitResponsesEvent( out, 'response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: state.currentOutputIndex,
                    item: {
                        type: 'message',
                        id: itemId,
                        role: 'assistant',
                        status: 'in_progress',
                        content: [],
                    },
                } );
                emitResponsesEvent( out, 'response.content_part.added', {
                    type: 'response.content_part.added',
                    output_index: state.currentOutputIndex,
                    content_index: state.contentBlockIndex,
                    part: {
                        type: 'output_text',
                        text: '',
                    },
                } );
                state.currentTextBlockOpen = true;
            } else {
                const lastText = state.textItems[state.textItems.length - 1];
                if ( lastText ) lastText.text += content;
            }

            emitResponsesEvent( out, 'response.output_text.delta', {
                type: 'response.output_text.delta',
                output_index: state.currentOutputIndex,
                content_index: state.contentBlockIndex,
                delta: content,
            } );
        }

        // Accumulate tool calls from delta
        const toolCallDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if ( Array.isArray( toolCallDeltas ) ) {
            for ( const tcDelta of toolCallDeltas ) {
                const idx = tcDelta.index as number;
                if ( typeof idx !== 'number' ) continue;

                while ( state.toolCalls.length <= idx ) {
                    state.toolCalls.push( { id: '', name: '', arguments: '' } );
                }

                const existing = state.toolCalls[idx]!;
                const fnDelta = tcDelta.function as Record<string, unknown> | undefined;

                if ( tcDelta.id ) existing.id = tcDelta.id as string;
                if ( fnDelta?.name ) existing.name += fnDelta.name as string;
                if ( fnDelta?.arguments ) existing.arguments += fnDelta.arguments as string;
            }
        }
    }

    // Handle finish_reason — check regardless of whether delta exists
    if ( finishReason && finishReason !== 'null' ) {
        closeReasoningBlock( state, out );
        if ( state.currentTextBlockOpen ) {
            const lastTextItem = state.textItems[state.textItems.length - 1];
            const accumulatedText = lastTextItem?.text ?? '';
            emitResponsesEvent( out, 'response.content_part.done', {
                type: 'response.content_part.done',
                output_index: state.currentOutputIndex,
                content_index: state.contentBlockIndex,
                part: {
                    type: 'output_text',
                    text: accumulatedText,
                },
            } );
            emitResponsesEvent( out, 'response.output_item.done', {
                type: 'response.output_item.done',
                output_index: state.currentOutputIndex,
                item: {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [],
                },
            } );
            state.currentOutputIndex++;
            state.contentBlockIndex = 0;
            state.currentTextBlockOpen = false;
        }

        finishResponsesStream( state, out );
        return true;
    }

    return false;
}
