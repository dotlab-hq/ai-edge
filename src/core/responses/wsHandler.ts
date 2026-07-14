import type { WSConnection } from './wsTypes';
import { globalResponseCache } from './wsTypes';
import { convertResponsesRequestToChat } from './requestToChat';
import { convertChatResponseToResponses } from './chatToResponses';
import {
    generateResponseId,
    normaliseInput,
    trimResponseCache,
    shouldCompressContext,
    compressContext,
    safeParseJson,
} from './wsHelpers';
import { emitEvent, emitJson } from './wsContext';
import { streamUpstreamToWebSocket } from './wsStream';
import { openAIProxy } from '../OpenAIProxy';

export async function handleResponseCreate( conn: WSConnection, msg: any ): Promise<void> {
    const { stream: _stream, background: _background, response, ...rest } = msg;
    // ponytail: OpenAI nests request fields under `response`; merge so nested wins, top-level kept for backward compat.
    const payload = response ? { ...rest, ...response } : rest;
    if ( process.env.AI_EDGE_DEBUG === '1' ) console.log( `[ws:responses] ← flattened payload=${JSON.stringify( payload ).slice( 0, 2000 )}` );
    const isWarmup = payload.generate === false;
    const prevId = payload.previous_response_id || null;
    const newInput = normaliseInput( payload.input );
    const model: string | undefined = payload.model;

    if ( !model ) {
        emitJson( conn, {
            type: 'error',
            status: 400,
            error: { type: 'invalid_request_error', code: 'missing_model', message: 'model is required' },
        } );
        return;
    }

    let fullInput: any[];
    let chatBody: any;
    // ponytail: Codex sends chat `messages` to /v1/responses — use directly, skip Responses conversion.
    const isChatFormat = !payload.input && Array.isArray( payload.messages );

    if ( prevId ) {
        const cached = conn.responseCache.get( prevId );
        if ( !cached ) {
            emitJson( conn, {
                type: 'error',
                status: 400,
                error: {
                    type: 'invalid_request_error',
                    code: 'previous_response_not_found',
                    message: `Previous response with id '${prevId}' not found.`,
                    param: 'previous_response_id',
                },
            } );
            return;
        }

        fullInput = [ ...cached.inputItems, ...cached.outputItems, ...newInput ];

        const mergedPayload = { ...payload, input: fullInput };
        if ( cached.instructions ) {
            mergedPayload.instructions = cached.instructions;
        }
        chatBody = isChatFormat ? payload : convertResponsesRequestToChat( mergedPayload );
    } else {
        fullInput = isChatFormat ? payload.messages : newInput;
        chatBody = isChatFormat ? payload : convertResponsesRequestToChat( payload );
    }

    const responseId = generateResponseId();

    if ( isWarmup ) {
        const cached: any = {
            inputItems: fullInput,
            outputItems: [],
            model,
            instructions: payload.instructions,
            responseId,
            created: Math.floor( Date.now() / 1000 ),
        };
        conn.responseCache.set( responseId, cached );
        globalResponseCache.set( responseId, cached );
        emitJson( conn, {
            type: 'response.created',
            response: {
                id: responseId,
                object: 'response',
                status: 'in_progress',
                created: Math.floor( Date.now() / 1000 ),
                model,
                output: [],
            },
        } );
        return;
    }

    if ( shouldCompressContext( fullInput ) ) {
        const { compressed, dropped } = compressContext( fullInput );
        if ( compressed.length < fullInput.length ) {
            fullInput = compressed;
            chatBody = convertResponsesRequestToChat( { ...payload, input: fullInput } );
            console.info( `[ws:responses] context_compressed dropped=${dropped} remaining=${compressed.length}` );
        }
    }

    chatBody.stream = true;
    chatBody.stream_options = { include_usage: true };

    console.info( `[ws:responses] upstream_request model=${model} messages=${chatBody.messages?.length ?? 0} tools=${chatBody.tools?.length ?? 0} prevId=${prevId ?? 'none'}` );
    console.info( `[ws:responses] fullInput types=${fullInput.map( ( i: any ) => i.type ?? i.role ?? '?' ).join( ',' )}` );
    if ( chatBody.messages ) {
        for ( const m of chatBody.messages ) {
            const tcIds = m.tool_calls?.map( ( tc: any ) => tc.id ) ?? [];
            console.info( `[ws:responses]   msg role=${m.role} tool_call_id=${m.tool_call_id ?? '-'} tool_calls=${tcIds.length ? tcIds.join( ',' ) : '-'}` );
        }
    }
    const result = await openAIProxy.processUpstreamWithFallback( chatBody, 'chat/completions', {
        responseId,
        model,
        stream: true,
    } );

    if ( !result.response ) {
        emitJson( conn, {
            type: 'error',
            status: result.status,
            error: result.payload?.error ?? { type: 'upstream_error', message: 'No upstream response' },
        } );
        return;
    }

    const upstreamRes = result.response;
    const providerId = result.providerId!;
    const selectedModel = result.selectedModel!;

    if ( !upstreamRes.ok ) {
        const errPayload = await safeParseJson( upstreamRes );
        console.error( `[ws:responses] ${upstreamRes.status} from ${providerId} error=${JSON.stringify( errPayload?.error ?? errPayload ).slice( 0, 300 )}` );
        emitJson( conn, {
            type: 'error',
            status: upstreamRes.status,
            error: errPayload?.error ?? { type: 'upstream_error', message: `Upstream error ${upstreamRes.status}` },
        } );
        if ( prevId ) conn.responseCache.delete( prevId );
        return;
    }

    const streamHeader = upstreamRes.headers.get( 'content-type' ) ?? '';
    if ( streamHeader.includes( 'text/event-stream' ) && upstreamRes.body ) {
        const cachedInstructions = prevId ? conn.responseCache.get( prevId )?.instructions : undefined;
        await streamUpstreamToWebSocket( conn, upstreamRes, responseId, providerId, selectedModel, fullInput, model, cachedInstructions ?? payload.instructions, prevId );
        return;
    }

    const chatPayload = await safeParseJson( upstreamRes );
    if ( !chatPayload || !upstreamRes.ok ) {
        emitJson( conn, {
            type: 'error',
            status: 502,
            error: { type: 'upstream_error', message: 'Failed to parse upstream response' },
        } );
        return;
    }

    const responsesPayload = convertChatResponseToResponses( chatPayload, payload );
    responsesPayload.id = responseId;

    const outputItems = responsesPayload.output as any[] ?? [];
    const cachedInstructions = prevId ? conn.responseCache.get( prevId )?.instructions : undefined;
    const cached: any = {
        inputItems: fullInput,
        outputItems,
        model,
        instructions: cachedInstructions ?? payload.instructions,
    };
    conn.responseCache.set( responseId, cached );
    globalResponseCache.set( responseId, cached );
    trimResponseCache( conn );

    emitEvent( conn, 'response.created', {
        type: 'response.created',
        response: {
            id: responseId,
            object: 'response',
            status: 'in_progress',
            created: responsesPayload.created ?? Math.floor( Date.now() / 1000 ),
            model,
            output: [],
        },
    } );

    emitEvent( conn, 'response.in_progress', {
        type: 'response.in_progress',
        response: { id: responseId, status: 'in_progress' },
    } );

    for ( let i = 0; i < outputItems.length; i++ ) {
        const item = outputItems[i];

        emitEvent( conn, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: i,
            item,
        } );

        if ( item.type === 'message' && Array.isArray( item.content ) ) {
            for ( let j = 0; j < item.content.length; j++ ) {
                const part = item.content[j];
                emitEvent( conn, 'response.content_part.added', {
                    type: 'response.content_part.added',
                    output_index: i,
                    content_index: j,
                    part: { type: part.type, text: '' },
                } );

                if ( part.type === 'output_text' && typeof part.text === 'string' ) {
                    emitEvent( conn, 'response.output_text.delta', {
                        type: 'response.output_text.delta',
                        output_index: i,
                        content_index: j,
                        delta: part.text,
                    } );
                }

                emitEvent( conn, 'response.content_part.done', {
                    type: 'response.content_part.done',
                    output_index: i,
                    content_index: j,
                    part,
                } );
            }
        }

        emitEvent( conn, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: i,
            item,
        } );
    }

    emitEvent( conn, 'response.completed', {
        type: 'response.completed',
        response: {
            id: responseId,
            object: 'response',
            status: 'completed',
            created: responsesPayload.created ?? Math.floor( Date.now() / 1000 ),
            model,
            output: outputItems,
            usage: responsesPayload.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
    } );

    console.info( `[ws:responses] success provider=${providerId} model=${selectedModel}` );
}
