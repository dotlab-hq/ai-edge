import type { AnthropicMessage, AnthropicMessageRequest } from '../types/anthropic';
import type { OpenAIMessage, OpenAIChatRequest } from '../types/openai';
import { convertToolChoiceToOpenAI, convertToolsToOpenAI } from './tools';
import { generateXmlToolInstructions } from './xmlPrompt';
import type { ToolIdDeduplicationContext } from './requestTypes';
import { createDedupeContext } from './requestTypes';
import { processUserContentBlocks, processAssistantContentBlocks } from './requestContent';

const CLAUDE_CODE_IDENTIFIER = "You are Claude Code, Anthropic's official CLI for Claude.";
const LOCAL_BRANDED_IDENTIFIER = 'You are Claude Code, running through the local Claude adapter in ai-edge.';

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

    const idDeduplication = createDedupeContext();

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

// Re-export content processing for external consumers
export { processUserContentBlocks, processAssistantContentBlocks } from './requestContent';
export type { ToolIdDeduplicationContext, UserContentResult, AssistantContentResult } from './requestTypes';
