import type { AnthropicContentBlock, AnthropicDocumentBlock, AnthropicMessage, AnthropicToolResultBlock } from '../types/anthropic';
import type { OpenAIToolCall, OpenAIToolMessage, OpenAIUserContentPart } from '../types/openai';
import type { AssistantContentResult, ToolIdDeduplicationContext, UserContentResult } from './requestTypes';
import { convertImageSourceToOpenAIUrl, convertAudioSourceToOpenAIInput, convertFileSourceToOpenAIFile } from './requestSourceConverters';

export function processUserContentBlocks(
    blocks: AnthropicContentBlock[],
    dedupeContext: ToolIdDeduplicationContext
): UserContentResult {
    const userContent: OpenAIUserContentPart[] = [];
    const toolResults: OpenAIToolMessage[] = [];

    for ( const block of blocks ) {
        if ( block.type === 'text' ) {
            userContent.push( { type: 'text', text: block.text } );
            continue;
        }

        if ( block.type === 'image' ) {
            const imageUrl = convertImageSourceToOpenAIUrl( block.source );
            if ( imageUrl ) {
                userContent.push( { type: 'image_url', image_url: { url: imageUrl } } );
            }
            continue;
        }

        if ( block.type === 'audio' ) {
            const inputAudio = convertAudioSourceToOpenAIInput( block.source );
            if ( inputAudio ) {
                userContent.push( { type: 'input_audio', input_audio: inputAudio } );
            }
            continue;
        }

        if ( block.type === 'file' ) {
            const file = convertFileSourceToOpenAIFile( block.source );
            if ( file ) {
                userContent.push( { type: 'file', file } );
            }
            continue;
        }

        // Document blocks (resolved by SkillResolver to base64, or URL-based)
        if ( block.type === 'document' ) {
            const docBlock = block as AnthropicDocumentBlock;
            const source = docBlock.source as { type: string; media_type?: string; data?: string; url?: string } | undefined;
            if ( source?.type === 'base64' && source.data ) {
                // Decode base64 - for text types inject as text, for binary types use image_url data URL
                const mimeType = ( source.media_type || 'text/plain' ).toLowerCase();
                const isTextType = mimeType.startsWith( 'text/' ) ||
                    mimeType === 'application/json' ||
                    mimeType === 'application/xml' ||
                    mimeType === 'application/javascript' ||
                    mimeType === 'application/x-javascript' ||
                    mimeType === 'application/typescript';
                if ( isTextType ) {
                    try {
                        const decoded = Buffer.from( source.data, 'base64' ).toString( 'utf-8' );
                        userContent.push( { type: 'text', text: decoded } );
                    } catch {
                        // If decode fails, skip
                    }
                } else if ( mimeType === 'application/pdf' ) {
                    // PDFs are not natively supported in OpenAI Chat Completions.
                    // Inject a text placeholder rather than misrepresenting as image_url.
                    userContent.push( { type: 'text', text: '[PDF attachment — this provider does not support PDF input via chat completions. Try uploading the file via the Files API or using the Responses API.]' } );
                } else {
                    // Other binary documents — use data URL in image_url block
                    const dataUrl = `data:${mimeType};base64,${source.data}`;
                    userContent.push( { type: 'image_url', image_url: { url: dataUrl } } );
                }
                continue;
            }
            if ( source?.type === 'url' && source.url ) {
                userContent.push( { type: 'image_url', image_url: { url: source.url } } );
                continue;
            }
            // Unresolved file reference - emit text fallback so model sees something
            const rawSource = ( docBlock.source as any ) ?? {};
            if ( rawSource?.type === 'file' && rawSource.file_id ) {
                userContent.push( { type: 'text', text: `[Attached file: ${rawSource.file_id}]` } );
            } else {
                userContent.push( { type: 'text', text: '[Unresolved document attachment]' } );
            }
            continue;
        }

        if ( block.type !== 'tool_result' ) {
            continue;
        }

        const toolResultBlock = block as AnthropicToolResultBlock;
        let content: string;

        if ( typeof toolResultBlock.content === 'string' ) {
            content = toolResultBlock.content;
        } else if ( Array.isArray( toolResultBlock.content ) ) {
            content = toolResultBlock.content
                .filter( ( contentBlock ) => contentBlock.type === 'text' )
                .map( ( contentBlock ) => contentBlock.text )
                .join( '\n' );
        } else {
            content = '';
        }

        let toolCallId = toolResultBlock.tool_use_id;
        if ( dedupeContext.idMappings.has( toolResultBlock.tool_use_id ) ) {
            const mappings = dedupeContext.idMappings.get( toolResultBlock.tool_use_id )!;
            const currentIndex = dedupeContext.resultIndex.get( toolResultBlock.tool_use_id ) ?? 0;
            const mappedId = mappings[currentIndex];
            if ( mappedId ) {
                toolCallId = mappedId;
                dedupeContext.resultIndex.set( toolResultBlock.tool_use_id, currentIndex + 1 );
            }
        }

        toolResults.push( {
            role: 'tool',
            tool_call_id: toolCallId,
            content: toolResultBlock.is_error ? `Error: ${content}` : content,
        } );
    }

    return { userContent, toolResults };
}

export function processAssistantContentBlocks(
    blocks: AnthropicContentBlock[],
    dedupeContext: ToolIdDeduplicationContext
): AssistantContentResult {
    let textContent = '';
    const toolCalls: OpenAIToolCall[] = [];

    for ( const block of blocks ) {
        if ( block.type === 'text' ) {
            textContent += block.text;
            continue;
        }

        if ( block.type === 'thinking' ) {
            continue;
        }

        if ( block.type !== 'tool_use' ) {
            continue;
        }

        let idToUse = block.id;
        if ( dedupeContext.seenIds.has( block.id ) ) {
            const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            const originalLength = block.id.length;

            if ( originalLength > 11 ) {
                idToUse = block.id.substring( 0, 8 );
                for ( let i = 8; i < originalLength; i++ ) {
                    idToUse += chars.charAt( Math.floor( Math.random() * chars.length ) );
                }
            } else {
                idToUse = '';
                for ( let i = 0; i < originalLength; i++ ) {
                    idToUse += chars.charAt( Math.floor( Math.random() * chars.length ) );
                }
            }
        }

        dedupeContext.seenIds.add( idToUse );
        if ( !dedupeContext.idMappings.has( block.id ) ) {
            dedupeContext.idMappings.set( block.id, [] );
        }
        dedupeContext.idMappings.get( block.id )!.push( idToUse );

        const toolCall: OpenAIToolCall = {
            id: idToUse,
            type: 'function',
            function: {
                name: block.name,
                arguments: JSON.stringify( block.input ),
            },
        };

        const FALLBACK_SIG = 'skip_thought_signature_validator';
        const thoughtSignature = ( block as { _google?: { thought_signature?: string } } )?._google?.thought_signature
            || ( block as { extra_content?: { google?: { thought_signature?: string } } } )?.extra_content?.google?.thought_signature
            || FALLBACK_SIG;
        ( toolCall as any ).function.thought_signature = thoughtSignature;
        ( toolCall as any ).extra_content = {
            google: {
                thought_signature: thoughtSignature,
            },
        };

        toolCalls.push( toolCall );
    }

    return { textContent, toolCalls };
}

export type { AnthropicMessage };
