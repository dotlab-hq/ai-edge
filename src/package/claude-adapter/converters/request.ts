import type { AnthropicContentBlock, AnthropicMessage, AnthropicMessageRequest, AnthropicToolResultBlock } from '../types/anthropic';
import type {
    OpenAIChatRequest,
    OpenAIMessage,
    OpenAIToolCall,
    OpenAIToolMessage,
    OpenAIUserContentPart,
} from '../types/openai';
import { convertToolChoiceToOpenAI, convertToolsToOpenAI } from './tools';
import { generateXmlToolInstructions } from './xmlPrompt';

const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";
const LOCAL_BRANDED_IDENTIFIER = 'You are Claude Code, running through the local Claude adapter in ai-edge.';

interface ToolIdDeduplicationContext {
    seenIds: Set<string>;
    idMappings: Map<string, string[]>;
    resultIndex: Map<string, number>;
}

interface UserContentResult {
    userContent: OpenAIUserContentPart[];
    toolResults: OpenAIToolMessage[];
}

interface AssistantContentResult {
    textContent: string;
    toolCalls: OpenAIToolCall[];
}

function modifySystemPromptForLocalAdapter( systemContent: string ): string {
    if ( systemContent.includes( CLAUDE_CODE_IDENTIFIER ) ) {
        return systemContent.replace( CLAUDE_CODE_IDENTIFIER, LOCAL_BRANDED_IDENTIFIER );
    }

    return systemContent;
}

/**
 * Convert Anthropic Messages API request to OpenAI Chat Completions format.
 * Supports Gemini native parts passthrough for multi-turn exact replay.
 */
export function convertRequestToOpenAI(
    anthropicRequest: AnthropicMessageRequest,
    targetModel: string,
    toolFormat: 'native' | 'xml' = 'native'
): OpenAIChatRequest {
    const messages: OpenAIMessage[] = [];

    if ( anthropicRequest.system ) {
        const systemContent = typeof anthropicRequest.system === 'string'
            ? anthropicRequest.system
            : anthropicRequest.system.map( ( systemBlock ) => systemBlock.text ).join( '\n' );

        const modifiedSystemContent = modifySystemPromptForLocalAdapter( systemContent );
        messages.push( {
            role: 'system',
            content: modifiedSystemContent,
        } );
    }

    if ( toolFormat === 'xml' && anthropicRequest.tools && anthropicRequest.tools.length > 0 ) {
        const xmlInstructions = generateXmlToolInstructions( anthropicRequest.tools );
        const firstMessage = messages[0];
        if ( firstMessage && firstMessage.role === 'system' ) {
            firstMessage.content += `\n\n${xmlInstructions}`;
        } else {
            messages.unshift( { role: 'system', content: xmlInstructions } );
        }
    }

    const idDeduplication: ToolIdDeduplicationContext = {
        seenIds: new Set<string>(),
        idMappings: new Map<string, string[]>(),
        resultIndex: new Map<string, number>(),
    };

    for ( const message of anthropicRequest.messages ) {
        const convertedMessages = convertMessage( message, idDeduplication, toolFormat );
        messages.push( ...convertedMessages );
    }

    const maxTokens = anthropicRequest.max_tokens === 1 ? 32 : anthropicRequest.max_tokens;

    const openaiRequest: OpenAIChatRequest = {
        model: targetModel,
        messages,
        max_tokens: maxTokens,
        stream: anthropicRequest.stream,
    };

    if ( anthropicRequest.stream ) {
        openaiRequest.stream_options = { include_usage: true };
    }

    if ( anthropicRequest.temperature !== undefined ) {
        openaiRequest.temperature = anthropicRequest.temperature;
    }

    if ( toolFormat === 'xml' ) {
        openaiRequest.temperature = 0;
    }

    if ( anthropicRequest.top_p !== undefined ) {
        openaiRequest.top_p = anthropicRequest.top_p;
    }

    if ( anthropicRequest.stop_sequences ) {
        openaiRequest.stop = anthropicRequest.stop_sequences;
    }

    if ( toolFormat === 'native' && anthropicRequest.tools && anthropicRequest.tools.length > 0 ) {
        openaiRequest.tools = convertToolsToOpenAI( anthropicRequest.tools );
    }

    if ( toolFormat === 'native' && anthropicRequest.tool_choice ) {
        openaiRequest.tool_choice = convertToolChoiceToOpenAI( anthropicRequest.tool_choice );
    }

    return openaiRequest;
}

function isAssistantPrefill( content: string ): boolean {
    const prefillTokens = ['{', '[', '```', '{"', '[{', '<', '<tool_code', '<tool_code>'];
    const trimmed = content.trim();

    if ( prefillTokens.includes( trimmed ) || trimmed.length <= 2 ) {
        return true;
    }

    return trimmed.startsWith( '<tool_code' ) && !trimmed.includes( '</tool_code>' );
}

function convertMessage(
    message: AnthropicMessage,
    dedupeContext: ToolIdDeduplicationContext,
    toolFormat: 'native' | 'xml'
): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    if ( typeof message.content === 'string' ) {
        if ( message.role === 'user' ) {
            result.push( { role: 'user', content: message.content } );
        } else if ( !isAssistantPrefill( message.content ) ) {
            const assistantMsg: any = { role: 'assistant', content: message.content };
            // Propagate Gemini metadata if present
            if ( message._gemini?.parts ) {
                assistantMsg._gemini = { parts: message._gemini.parts };
            }
            result.push( assistantMsg );
        }
        return result;
    }

    if ( message.role === 'user' ) {
        const { userContent, toolResults } = processUserContentBlocks( message.content, dedupeContext );

        if ( toolFormat === 'xml' ) {
            let flatContent = '';
            for ( const part of userContent ) {
                if ( part.type === 'text' ) {
                    flatContent += part.text;
                }
            }

            if ( toolResults.length > 0 ) {
                const xmlResults = toolResults.map( ( toolResult ) => `<tool_output>\n${toolResult.content}\n</tool_output>` ).join( '\n\n' );
                if ( flatContent ) {
                    flatContent += '\n\n';
                }
                flatContent += xmlResults;
            }

            if ( flatContent ) {
                result.push( { role: 'user', content: flatContent } );
            }
            return result;
        }

        result.push( ...toolResults );
        if ( userContent.length > 0 ) {
            const firstContent = userContent[0];
            result.push( {
                role: 'user',
                content: userContent.length === 1 && firstContent && firstContent.type === 'text'
                    ? firstContent.text
                    : userContent,
            } );
        }

        return result;
    }

    const { textContent, toolCalls } = processAssistantContentBlocks( message.content, dedupeContext );
    if ( toolCalls.length === 0 && textContent && isAssistantPrefill( textContent ) ) {
        return result;
    }

    if ( toolFormat === 'xml' ) {
        let fullContent = textContent || '';
        if ( toolCalls.length > 0 ) {
            const xmlToolCalls = toolCalls.map( ( toolCall ) => {
                const args = toolCall.function.arguments;
                return `<tool_code name="${toolCall.function.name}">\n${args}\n</tool_code>`;
            } ).join( '\n\n' );

            if ( fullContent ) {
                fullContent += '\n\n';
            }
            fullContent += xmlToolCalls;
        }

        result.push( {
            role: 'assistant',
            content: fullContent,
        } );
        return result;
    }

    const assistantMessage: any = {
        role: 'assistant',
        content: textContent || null,
    };

    if ( toolCalls.length > 0 && assistantMessage.role === 'assistant' ) {
        assistantMessage.tool_calls = toolCalls;
    }

    // Propagate Gemini metadata if present
    if ( message._gemini?.parts ) {
        assistantMessage._gemini = { parts: message._gemini.parts };
    }

    result.push( assistantMessage );
    return result;
}

function processUserContentBlocks(
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

function processAssistantContentBlocks(
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
        (toolCall as any).extra_content = {
            google: {
                thought_signature: thoughtSignature,
            },
        };

        toolCalls.push( toolCall );
    }

    return { textContent, toolCalls };
}

function convertImageSourceToOpenAIUrl( source: Extract<AnthropicContentBlock, { type: 'image' }>['source'] ): string | undefined {
    if ( !source || typeof source !== 'object' ) {
        return undefined;
    }

    if ( source.type === 'url' && typeof source.url === 'string' ) {
        return source.url;
    }

    if ( source.type === 'base64' && typeof source.data === 'string' ) {
        const mediaType = typeof source.media_type === 'string' && source.media_type.length > 0
            ? source.media_type
            : 'image/png';
        return `data:${mediaType};base64,${source.data}`;
    }

    if ( source.type === 'file' && typeof source.file_id === 'string' ) {
        return source.file_id;
    }

    return undefined;
}

function convertAudioSourceToOpenAIInput( source: Extract<AnthropicContentBlock, { type: 'audio' }>['source'] ): { data?: string; format?: string; url?: string; file_id?: string } | undefined {
    if ( !source || typeof source !== 'object' ) {
        return undefined;
    }

    if ( source.type === 'base64' && typeof source.data === 'string' ) {
        return {
            data: source.data,
            format: typeof source.media_type === 'string' ? source.media_type.split( '/' ).pop() : undefined,
        };
    }

    if ( source.type === 'url' && typeof source.url === 'string' ) {
        return { url: source.url };
    }

    if ( source.type === 'file' && typeof source.file_id === 'string' ) {
        return { file_id: source.file_id };
    }

    return undefined;
}

function convertFileSourceToOpenAIFile( source: Extract<AnthropicContentBlock, { type: 'file' }>['source'] ): { file_id?: string; file_data?: string; url?: string; media_type?: string } | undefined {
    if ( !source || typeof source !== 'object' ) {
        return undefined;
    }

    if ( source.type === 'file' && typeof source.file_id === 'string' ) {
        return { file_id: source.file_id };
    }

    if ( source.type === 'base64' && typeof source.data === 'string' ) {
        return {
            file_data: source.data,
            media_type: typeof source.media_type === 'string' ? source.media_type : undefined,
        };
    }

    if ( source.type === 'url' && typeof source.url === 'string' ) {
        return { url: source.url };
    }

    return undefined;
}
