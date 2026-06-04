/**
 * Converts between OpenAI Responses API and Chat Completions formats.
 *
 * When an upstream backend only supports `/chat/completions`, these utilities
 * translate a `/responses` request into chat/completions format and rebuild
 * the upstream response in Responses shape so the caller never notices.
 */

// ────────────────────────────────────────────────────────────────
// Types (minimal, only what the converters reference)
// ────────────────────────────────────────────────────────────────

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null | Array<Record<string, unknown>>;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
}

interface ChatTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}

interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    tools?: ChatTool[];
    tool_choice?: unknown;
    reasoning_effort?: string;
    stop?: string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    seed?: number;
    stream_options?: { include_usage: boolean };
    [key: string]: unknown;
}

interface ChatCompletionResponse {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    system_fingerprint?: string;
    choices?: Array<{
        index?: number;
        message?: { role?: string; content?: string | null; tool_calls?: unknown[] };
        finish_reason?: string;
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
    };
}

interface ResponsesRequest {
    model: string;
    input?: string | Array<Record<string, unknown>>;
    instructions?: string;
    max_output_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    tools?: Array<Record<string, unknown>>;
    tool_choice?: unknown;
    reasoning?: Record<string, unknown>;
    reasoning_effort?: string;
    stop?: string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    seed?: number;
    [key: string]: unknown;
}

interface ResponsesOutputItem {
    type: string;
    [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────────
// Request: Responses → Chat Completions
// ────────────────────────────────────────────────────────────────

export function convertResponsesRequestToChat( request: ResponsesRequest ): ChatCompletionRequest {
    const messages = buildMessagesFromResponsesInput( request );
    const chatRequest: ChatCompletionRequest = {
        model: request.model,
        messages,
    };

    if ( request.max_output_tokens != null ) {
        chatRequest.max_tokens = request.max_output_tokens;
    }
    if ( request.temperature != null ) chatRequest.temperature = request.temperature;
    if ( request.top_p != null ) chatRequest.top_p = request.top_p;
    if ( request.stream != null ) chatRequest.stream = request.stream;
    if ( request.stop ) chatRequest.stop = request.stop;
    if ( request.presence_penalty != null ) chatRequest.presence_penalty = request.presence_penalty;
    if ( request.frequency_penalty != null ) chatRequest.frequency_penalty = request.frequency_penalty;
    if ( request.seed != null ) chatRequest.seed = request.seed;

    if ( request.stream ) {
        chatRequest.stream_options = { include_usage: true };
    }

    const tools = convertToolsToChat( request.tools );
    if ( tools.length > 0 ) chatRequest.tools = tools;

    const toolChoice = convertToolChoiceToChat( request.tool_choice );
    if ( toolChoice ) chatRequest.tool_choice = toolChoice;

    const reasoningEffort = resolveReasoningEffort( request );
    if ( reasoningEffort ) chatRequest.reasoning_effort = reasoningEffort;

    // Carry through any extra fields not explicitly mapped
    for ( const [key, value] of Object.entries( request ) ) {
        if ( !( key in chatRequest ) && value !== undefined ) {
            ( chatRequest as Record<string, unknown> )[key] = value;
        }
    }

    return chatRequest;
}

function buildMessagesFromResponsesInput( request: ResponsesRequest ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // `instructions` → system message
    if ( typeof request.instructions === 'string' && request.instructions.trim() ) {
        messages.push( { role: 'system', content: request.instructions } );
    }

    const inputItems = normaliseInputItems( request.input );

    for ( const item of inputItems ) {
        const mapped = mapInputItemToMessage( item );
        if ( mapped ) {
            if ( Array.isArray( mapped ) ) {
                messages.push( ...mapped );
            } else {
                messages.push( mapped );
            }
        }
    }

    return messages;
}

function normaliseInputItems( input: ResponsesRequest['input'] ): Array<Record<string, unknown>> {
    if ( input == null ) return [];
    if ( typeof input === 'string' ) return [{ role: 'user', content: input }];
    if ( Array.isArray( input ) ) return input;
    return [];
}

function mapInputItemToMessage( item: Record<string, unknown> ): ChatMessage | ChatMessage[] | null {
    const type = item.type as string | undefined;

    // ── function_call (model requesting to call a tool) ──
    if ( type === 'function_call' ) {
        return {
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: ( item.call_id as string ) || ( item.id as string ) || generateId( 'call' ),
                type: 'function',
                function: {
                    name: ( item.name as string ) || '',
                    arguments: ( item.arguments as string ) || '{}',
                },
            }],
        };
    }

    // ── function_call_output (tool result from caller) ──
    if ( type === 'function_call_output' ) {
        return {
            role: 'tool',
            tool_call_id: ( item.call_id as string ) || '',
            content: typeof item.output === 'string' ? item.output : JSON.stringify( item.output ?? '' ),
        };
    }

    // ── message items (role-based) ──
    const role = ( item.role as string ) || 'user';

    if ( role === 'system' || role === 'developer' ) {
        return { role: 'system', content: flattenContent( item.content ) };
    }

    if ( role === 'assistant' ) {
        // Assistant with tool_calls embedded in the output array
        if ( type === 'function_call' ) {
            // Already handled above, but guard
            return null;
        }
        const toolCalls = extractToolCallsFromAssistantItem( item );
        return {
            role: 'assistant',
            content: flattenContent( item.content ),
            ...( toolCalls.length > 0 ? { tool_calls: toolCalls } : {} ),
        };
    }

    // user or default
    return { role: 'user', content: flattenContent( item.content ) };
}

function flattenContent( content: unknown ): string | Array<Record<string, unknown>> | null {
    if ( content == null ) return null;
    if ( typeof content === 'string' ) return content;
    if ( Array.isArray( content ) ) {
        const hasImages = content.some( ( block ) => {
            if ( !block || typeof block !== 'object' ) return false;
            const t = block.type as string;
            return ( t === 'input_image' && typeof block.image_url === 'string' )
                || ( t === 'image_url' && typeof ( block.image_url ?? block.url ) === 'string' );
        } );

        // Use multimodal content array format when images are present
        if ( hasImages ) {
            const parts: Array<Record<string, unknown>> = [];
            for ( const block of content ) {
                if ( !block || typeof block !== 'object' ) continue;
                const t = block.type as string;
                if ( t === 'input_text' && typeof block.text === 'string' ) {
                    parts.push( { type: 'text', text: block.text } );
                } else if ( t === 'input_image' && typeof block.image_url === 'string' ) {
                    parts.push( { type: 'image_url', image_url: { url: block.image_url } } );
                } else if ( t === 'image_url' && typeof ( block.image_url ?? block.url ) === 'string' ) {
                    parts.push( { type: 'image_url', image_url: { url: block.image_url ?? block.url } } );
                } else if ( typeof block.text === 'string' ) {
                    parts.push( { type: 'text', text: block.text } );
                }
            }
            return parts.length > 0 ? parts : null;
        }

        // Text-only: join into a flat string
        const texts: string[] = [];
        for ( const block of content ) {
            if ( !block || typeof block !== 'object' ) continue;
            const t = block.type as string;
            if ( t === 'input_text' && typeof block.text === 'string' ) {
                texts.push( block.text );
            } else if ( typeof block.text === 'string' ) {
                texts.push( block.text );
            }
        }
        return texts.join( '\n' ) || null;
    }
    if ( typeof content === 'object' && typeof ( content as any ).text === 'string' ) {
        return ( content as any ).text;
    }
    return null;
}

function extractToolCallsFromAssistantItem( item: Record<string, unknown> ): NonNullable<ChatMessage['tool_calls']> {
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    // Assistant message items may have tool_calls at the item level in some variants
    const calls = item.tool_calls as Array<Record<string, unknown>> | undefined;
    if ( !Array.isArray( calls ) ) return toolCalls;

    for ( const call of calls ) {
        if ( call.type === 'function' || call.function ) {
            toolCalls.push( {
                id: ( call.id as string ) || generateId( 'call' ),
                type: 'function',
                function: {
                    name: ( call.function as any )?.name ?? ( call.name as string ) ?? '',
                    arguments: ( call.function as any )?.arguments ?? ( call.arguments as string ) ?? '{}',
                },
            } );
        }
    }

    return toolCalls;
}

function convertToolsToChat( tools?: Array<Record<string, unknown>> ): ChatTool[] {
    if ( !tools || tools.length === 0 ) return [];

    return tools
        .filter( ( tool ) => {
            const t = tool.type as string;
            // Only function tools are convertible; skip Responses-native tools
            return t === 'function' || ( !t && typeof tool.function === 'object' );
        } )
        .map( ( tool ) => {
            const fn = ( tool.function ?? tool ) as Record<string, unknown>;
            return {
                type: 'function' as const,
                function: {
                    name: ( fn.name as string ) || '',
                    description: typeof fn.description === 'string' ? fn.description : undefined,
                    parameters: typeof fn.parameters === 'object' && fn.parameters !== null
                        ? fn.parameters as Record<string, unknown>
                        : undefined,
                    strict: typeof fn.strict === 'boolean' ? fn.strict : true,
                },
            };
        } );
}

function convertToolChoiceToChat( toolChoice: unknown ): unknown {
    if ( !toolChoice || typeof toolChoice !== 'object' ) {
        if ( typeof toolChoice === 'string' && ['auto', 'none', 'required'].includes( toolChoice ) ) {
            return toolChoice;
        }
        return undefined;
    }

    const tc = toolChoice as Record<string, unknown>;
    if ( tc.type === 'function' || tc.function ) {
        const fn = ( tc.function ?? tc ) as Record<string, unknown>;
        return {
            type: 'function',
            function: { name: fn.name },
        };
    }

    if ( typeof tc.type === 'string' && ['auto', 'none', 'required'].includes( tc.type ) ) {
        return tc.type;
    }

    return undefined;
}

function resolveReasoningEffort( request: ResponsesRequest ): string | undefined {
    // Explicit reasoning_effort wins
    if ( typeof request.reasoning_effort === 'string' ) return request.reasoning_effort;

    // Responses reasoning object: { summary: "auto" | "none" | "detailed" }
    const reasoning = request.reasoning as Record<string, unknown> | undefined;
    if ( reasoning && typeof reasoning === 'object' ) {
        const summary = reasoning.summary as string | undefined;
        if ( summary === 'none' ) return undefined;
        if ( summary === 'detailed' ) return 'high';
        if ( summary === 'auto' ) return undefined; // let upstream decide
    }

    return undefined;
}

// ────────────────────────────────────────────────────────────────
// Response: Chat Completions → Responses
// ────────────────────────────────────────────────────────────────

export function convertChatResponseToResponses(
    chatResponse: ChatCompletionResponse,
    originalRequest: ResponsesRequest,
): Record<string, unknown> {
    const choice = chatResponse.choices?.[0];
    const message = choice?.message;

    const output: ResponsesOutputItem[] = [];

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
        // Empty response — still emit a message item
        output.push( {
            type: 'message',
            id: generateId( 'msg' ),
            role: 'assistant',
            status: 'completed',
            content: [],
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
        id: chatResponse.id || generateId( 'resp' ),
        object: 'response',
        created: chatResponse.created ?? Math.floor( Date.now() / 1000 ),
        model: originalRequest.model,
        output,
        usage,
        status: 'completed',
        ...( chatResponse.system_fingerprint ? { system_fingerprint: chatResponse.system_fingerprint } : {} ),
    };
}

// ────────────────────────────────────────────────────────────────
// Streaming: Chat Completions SSE → Responses SSE
// ────────────────────────────────────────────────────────────────

export interface ResponsesStreamState {
    responseId: string;
    model: string;
    created: number;
    contentBlockIndex: number;
    currentOutputIndex: number;
    hasEmittedResponse: boolean;
    currentTextBlockOpen: boolean;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
    finished: boolean;
    requestStartedAt: number;
    firstEmissionLogged: boolean;
    textItems: Array<{ itemId: string; text: string }>;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

export function createResponsesStreamState( request: ResponsesRequest, requestStartedAt: number ): ResponsesStreamState {
    return {
        responseId: generateId( 'resp' ),
        model: request.model,
        created: Math.floor( Date.now() / 1000 ),
        contentBlockIndex: 0,
        currentOutputIndex: 0,
        hasEmittedResponse: false,
        currentTextBlockOpen: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        finished: false,
        requestStartedAt,
        firstEmissionLogged: false,
        textItems: [],
        toolCalls: [],
    };
}

export function emitResponsesStreamPreamble( state: ResponsesStreamState, out: string[] ): void {
    if ( state.hasEmittedResponse ) return;

    emitResponsesEvent( out, 'response.created', {
        type: 'response.created',
        response: {
            id: state.responseId,
            object: 'response',
            status: 'in_progress',
            created: state.created,
            model: state.model,
            output: [],
        },
    } );
    emitResponsesEvent( out, 'response.in_progress', {
        type: 'response.in_progress',
        response: {
            id: state.responseId,
            status: 'in_progress',
        },
    } );
    state.hasEmittedResponse = true;
}

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
        // Usage-only final chunk with no choices — finish
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
        const content = delta.content as string | undefined;

        if ( typeof content === 'string' && content.length > 0 ) {
            if ( !state.currentTextBlockOpen ) {
                // Track text item for cache
                const itemId = generateId( 'msg' );
                state.textItems.push( { itemId, text: content } );
                // Add output item
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
                // Start content block
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
                // Append to tracked text item
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

                // Ensure we have a slot for this tool call
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

    // Handle finish_reason — check regardless of whether delta exists,
    // because some providers send finish_reason in a separate chunk
    // without any content delta.
    if ( finishReason && finishReason !== 'null' ) {
        // Close text block if open
        if ( state.currentTextBlockOpen ) {
            emitResponsesEvent( out, 'response.content_part.done', {
                type: 'response.content_part.done',
                output_index: state.currentOutputIndex,
                content_index: state.contentBlockIndex,
                part: {
                    type: 'output_text',
                    text: '',
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

function finishResponsesStream( state: ResponsesStreamState, out: string[] ): void {
    if ( state.finished ) return;
    state.finished = true;

    // Close any lingering text block
    if ( state.currentTextBlockOpen ) {
        emitResponsesEvent( out, 'response.content_part.done', {
            type: 'response.content_part.done',
            output_index: state.currentOutputIndex,
            content_index: state.contentBlockIndex,
            part: { type: 'output_text', text: '' },
        } );
        emitResponsesEvent( out, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.currentOutputIndex,
            item: { type: 'message', role: 'assistant', status: 'completed', content: [] },
        } );
        state.currentOutputIndex++;
        state.contentBlockIndex = 0;
        state.currentTextBlockOpen = false;
    }

    // Emit output_item.done for any accumulated tool calls
    for ( const tc of state.toolCalls ) {
        if ( !tc.id ) continue;
        emitResponsesEvent( out, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.currentOutputIndex,
            item: {
                type: 'function_call',
                id: tc.id,
                call_id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            },
        } );
        state.currentOutputIndex++;
    }

    // NOTE: response.completed is NOT emitted here. The caller emits it
    // with the full output list (including tool calls from state.toolCalls).
}

function emitResponsesEvent( out: string[], eventType: string, data: Record<string, unknown> ): void {
    out.push( `event: ${eventType}\ndata: ${JSON.stringify( data )}\n\n` );
}

/**
 * Convert SSE-formatted event strings to plain JSON strings suitable for
 * WebSocket text frames. Codex's WebSocket client expects plain JSON (no SSE
 * framing) and parses each text frame as `ResponsesStreamEvent` directly.
 *
 * Input:  `event: response.created\ndata: {"type":"response.created",...}\n\n`
 * Output: `{"type":"response.created",...}`
 */
export function sseEventsToWsFrames( sseEvents: string[] ): string[] {
    const frames: string[] = [];
    for ( const event of sseEvents ) {
        // Extract JSON from the `data:` line
        const dataMatch = event.match( /data: (\{.*\})\n/s );
        if ( dataMatch?.[1] ) {
            frames.push( dataMatch[1] );
        }
    }
    return frames;
}

export function emitResponsesDoneSentinel( out: string[] ): void {
    out.push( 'data: [DONE]\n\n' );
}

/**
 * Build the full output items list from stream state (text items + tool calls)
 * and emit a single `response.completed` event.
 */
export function emitResponsesCompleted( state: ResponsesStreamState, out: string[] ): void {
    const output: any[] = [];

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

    // ── Fallback: estimate token counts when upstream didn't provide usage ──
    // Many non-OpenAI backends do not include `usage` in streaming chunks even
    // when `stream_options.include_usage` is set.  When all counters are still
    // at their initial value of 0, derive a rough estimate from the accumulated
    // content so the client shows meaningful numbers.
    let inputTokens = state.inputTokens;
    let outputTokens = state.outputTokens;
    let cachedInputTokens = state.cachedInputTokens;
    let reasoningTokens = state.reasoningTokens;

    if ( inputTokens === 0 && outputTokens === 0 ) {
        // Rough heuristic: ~1 token per 4 characters for English text
        const outputText = state.textItems.reduce( ( acc, ti ) => acc + ( ti.text ?? '' ), '' );
        const toolCallText = state.toolCalls.reduce( ( acc, tc ) => acc + ( tc.arguments ?? '' ), '' );
        outputTokens = Math.max( 1, Math.ceil( ( outputText.length + toolCallText.length ) / 4 ) );

        // We don't have the original request text at this point, so use a
        // minimal placeholder for input_tokens.  Most Codex turns are short
        // enough that a small estimate is acceptable; the important thing is
        // that the total is non-zero so the UI doesn't show "0 tokens".
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

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

let idCounter = 0;

function generateId( prefix: string ): string {
    const ts = Date.now().toString( 36 );
    const seq = ( ++idCounter ).toString( 36 ).padStart( 4, '0' );
    const rand = Math.random().toString( 36 ).substring( 2, 8 );
    return `${prefix}_${ts}${seq}${rand}`;
}

function buildEmptyUsage(): Record<string, unknown> {
    return {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
    };
}
