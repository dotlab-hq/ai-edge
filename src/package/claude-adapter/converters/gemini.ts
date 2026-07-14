import type { AnthropicMessageRequest } from '../types/anthropic';
import { reconstructGeminiPartsFromMessage, convertAnthropicContentToGeminiParts } from './geminiParts';
import type { GeminiContent, GeminiRequest, GeminiTool } from './geminiTypes';

export type { GeminiContent, GeminiPart, GeminiRequest, GeminiTool } from './geminiTypes';

/**
 * Convert Anthropic message request to Gemini format when native Gemini parts are available.
 * This enables exact replay of Gemini responses in multi-turn conversations by reconstructing
 * the original contents.parts structure with embedded thought_signature from thinking blocks.
 */
export function convertRequestToGemini(
    anthropicRequest: AnthropicMessageRequest,
    targetModel: string
): GeminiRequest {
    const contents: GeminiContent[] = [];

    // Add system instruction if present
    let systemInstruction: string | undefined;
    if ( anthropicRequest.system ) {
        systemInstruction = typeof anthropicRequest.system === 'string'
            ? anthropicRequest.system
            : anthropicRequest.system.map( ( systemBlock ) => systemBlock.text ).join( '\n' );
    }

    // Convert messages
    for ( const message of anthropicRequest.messages ) {
        // If this is an assistant message, check for Gemini provider state in thinking blocks
        if ( message.role === 'assistant' && Array.isArray( message.content ) ) {
            const reconstructedParts = reconstructGeminiPartsFromMessage( message.content );
            if ( reconstructedParts.length > 0 ) {
                console.log( `[Gemini] Reconstructed ${reconstructedParts.length} parts from assistant message` );
                reconstructedParts.forEach( (part: any, i: number) => {
                    if (part.functionCall) {
                        console.log( `  [${i}] functionCall "${part.functionCall.name}" has signature: ${!!part.functionCall.thought_signature}` );
                    }
                });
                contents.push( {
                    role: 'model',
                    parts: reconstructedParts,
                } );
                continue;
            }
        }

        // Otherwise, convert from Anthropic format
        const contentParts = convertAnthropicContentToGeminiParts( message );
        if ( contentParts.length > 0 ) {
            contents.push( {
                role: message.role === 'user' ? 'user' : 'model',
                parts: contentParts,
            } );
        }
    }

    const request: GeminiRequest = {
        model: targetModel,
        contents,
    };

    if ( systemInstruction ) {
        request.systemInstruction = systemInstruction;
    }

    if ( anthropicRequest.tools && anthropicRequest.tools.length > 0 ) {
        request.tools = [
            {
                functionDeclarations: anthropicRequest.tools.map( ( tool ) => ( {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.input_schema as any,
                } ) ),
            } as GeminiTool,
        ];

        if ( anthropicRequest.tool_choice ) {
            const mode = anthropicRequest.tool_choice.type === 'auto' ? 'AUTO' : 'ANY';
            request.toolConfig = {
                functionCallingConfig: {
                    mode,
                    allowedFunctionNames: anthropicRequest.tool_choice.name ? [anthropicRequest.tool_choice.name] : undefined,
                },
            };
        }
    }

    if ( anthropicRequest.temperature !== undefined || anthropicRequest.top_p !== undefined || anthropicRequest.stop_sequences ) {
        request.generationConfig = {
            temperature: anthropicRequest.temperature,
            topP: anthropicRequest.top_p,
            stopSequences: anthropicRequest.stop_sequences,
            maxOutputTokens: anthropicRequest.max_tokens,
        };
    }

    return request;
}
