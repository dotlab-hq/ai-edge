import type { OpenAIStreamChunk } from '@/package/claude-adapter';
import type { StreamState, SseOut } from './types';
import { generateUniqueToolId, getOrCreateThinkingSignature } from './types';
import {
    sendMessageStartSync,
    sendContentBlockStartSync,
    sendThinkingBlockStartSync,
    sendTextDeltaSync,
    sendThinkingDeltaSync,
    sendSignatureDeltaSync,
    sendInputJsonDeltaSync,
    sendContentBlockStopSync,
} from './events';
import { emitInitialContentBlocksSync } from './processing';

export function processOpenAIChunkSync( chunk: OpenAIStreamChunk, state: StreamState, out: SseOut ): boolean {
    if ( chunk.usage ) {
        state.inputTokens = chunk.usage.prompt_tokens;
        state.outputTokens = chunk.usage.completion_tokens;
        state.cachedInputTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }

    if ( chunk.model && !state.responseModel ) {
        state.responseModel = chunk.model;
    }

    const choice = chunk.choices[0];
    if ( !choice ) {
        return false;
    }

    if ( !state.hasStarted ) {
        sendMessageStartSync( state, out );
        state.hasStarted = true;
        emitInitialContentBlocksSync( state, out );
    }

    const delta = choice.delta;

    const reasoning = ( delta as any ).reasoning || ( delta as any ).reasoning_content || ( delta as any ).thinking || ( delta as any ).thought || ( delta as any ).reasoning_text;
    if ( typeof delta.reasoning_signature === 'string' ) {
        state.reasoningSignature = delta.reasoning_signature;
    } else if ( typeof delta.signature === 'string' ) {
        state.reasoningSignature = delta.signature;
    }

    if ( reasoning ) {
        if ( !state.reasoningEmittedStart ) {
            if ( state.textBlockOpen ) {
                sendContentBlockStopSync( state, state.contentBlockIndex, out );
                state.textBlockOpen = false;
                state.textContent = '';
                state.contentBlockIndex++;
            }
            sendThinkingBlockStartSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = true;
            state.reasoningEmittedStart = true;
        }
        sendThinkingDeltaSync( state, state.contentBlockIndex, reasoning, out );
    }

    if ( delta.content ) {
        if ( state.reasoningBlockOpen ) {
            const signature = getOrCreateThinkingSignature( state );
            sendSignatureDeltaSync( state, state.contentBlockIndex, signature, out );
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = false;
            state.reasoningEmittedEnd = true;
            state.contentBlockIndex++;
        }

        const existingType = state.openBlockTypes.get( state.contentBlockIndex );
        if ( !state.textBlockOpen || ( existingType && existingType !== 'text' ) ) {
            if ( state.textBlockOpen && existingType && existingType !== 'text' ) {
                sendContentBlockStopSync( state, state.contentBlockIndex, out );
                state.textBlockOpen = false;
                state.textContent = '';
                state.contentBlockIndex++;
            }
            sendContentBlockStartSync( state, state.contentBlockIndex, 'text', '', out );
            state.textBlockOpen = true;
        }

        state.textContent += delta.content;
        sendTextDeltaSync( state, state.contentBlockIndex, delta.content, out );
    }

    if ( delta.tool_calls ) {
        for ( const toolCall of delta.tool_calls ) {
            processToolCallDeltaSync( toolCall, state, out );
        }
    }

    if ( choice.finish_reason ) {
        state.lastFinishReason = choice.finish_reason;

        if ( state.reasoningBlockOpen ) {
            const signature = getOrCreateThinkingSignature( state );
            sendSignatureDeltaSync( state, state.contentBlockIndex, signature, out );
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = false;
            state.reasoningEmittedEnd = true;
            state.contentBlockIndex++;
        }

        if ( state.textBlockOpen ) {
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.textBlockOpen = false;
            state.textContent = '';
            state.contentBlockIndex++;
        }

        for ( const toolCall of state.currentToolCalls.values() ) {
            sendContentBlockStopSync( state, toolCall.blockIndex, out );
        }
        if ( state.currentToolCalls.size > 0 ) {
            const maxToolIndex = Math.max( ...Array.from( state.currentToolCalls.values() ).map( ( toolCall ) => toolCall.blockIndex ) );
            state.contentBlockIndex = Math.max( state.contentBlockIndex, maxToolIndex + 1 );
            state.currentToolCalls.clear();
        }
    }

    return state.finished;
}

export function processToolCallDeltaSync( toolCall: NonNullable<OpenAIStreamChunk['choices'][number]['delta']['tool_calls']>[number], state: StreamState, out: SseOut ): void {
    const index = toolCall.index;
    let currentCall = state.currentToolCalls.get( index );

    if ( !currentCall ) {
        if ( state.reasoningBlockOpen ) {
            const signature = getOrCreateThinkingSignature( state );
            sendSignatureDeltaSync( state, state.contentBlockIndex, signature, out );
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.reasoningBlockOpen = false;
            state.reasoningEmittedEnd = true;
            state.contentBlockIndex++;
        }

        if ( state.textBlockOpen ) {
            sendContentBlockStopSync( state, state.contentBlockIndex, out );
            state.textBlockOpen = false;
            state.textContent = '';
            state.contentBlockIndex++;
        }

        if ( !currentCall ) {
            const toolId = toolCall.id || generateUniqueToolId();
            currentCall = {
                id: toolId,
                name: toolCall.function?.name || '',
                arguments: '',
                blockIndex: state.contentBlockIndex + index,
            };
            state.currentToolCalls.set( index, currentCall );
            sendContentBlockStartSync( state, currentCall.blockIndex, 'tool_use', currentCall.name, out, currentCall.id );
        }
    }

    if ( toolCall.function?.name ) {
        currentCall.name = toolCall.function.name;
    }

    if ( toolCall.function?.arguments ) {
        currentCall.arguments += toolCall.function.arguments;
        sendInputJsonDeltaSync( state, currentCall.blockIndex, toolCall.function.arguments, out );
    }
}
