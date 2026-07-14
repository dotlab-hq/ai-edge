import type { AnthropicContentBlock, AnthropicMessageRequest } from '@/package/claude-adapter';
import { generateUniqueToolId } from './types';

export function normalizeAnthropicRequest( anthropicRequest: AnthropicMessageRequest ): AnthropicMessageRequest {
    const normalizedMessages: AnthropicMessageRequest['messages'] = [];
    const normalizedSystemBlocks = normalizeSystemBlocks( anthropicRequest.system );

    for ( const message of anthropicRequest.messages ?? [] ) {
        if ( message.role === 'user' || message.role === 'assistant' ) {
            normalizedMessages.push( normalizeAnthropicMessage( message ) );
            continue;
        }

        const extractedSystemText = extractSystemTextFromMessageContent( message.content );
        if ( extractedSystemText.length > 0 ) {
            normalizedSystemBlocks.push( ...extractedSystemText.map( ( text ) => ( { type: 'text' as const, text } ) ) );
        }
    }

    const normalizedTools = normalizeAnthropicTools( anthropicRequest.tools );

    const normalizedRequest: AnthropicMessageRequest = {
        ...anthropicRequest,
        messages: normalizedMessages,
        tools: normalizedTools,
    };

    if ( normalizedSystemBlocks.length > 0 ) {
        normalizedRequest.system = normalizedSystemBlocks;
    } else {
        delete ( normalizedRequest as Partial<AnthropicMessageRequest> ).system;
    }

    if ( !normalizedTools || normalizedTools.length === 0 ) {
        delete ( normalizedRequest as Partial<AnthropicMessageRequest> ).tools;
        delete ( normalizedRequest as Partial<AnthropicMessageRequest> ).tool_choice;
    } else if ( toolChoiceTargetsMissingTool( normalizedRequest.tool_choice, normalizedTools ) ) {
        delete ( normalizedRequest as Partial<AnthropicMessageRequest> ).tool_choice;
    }

    return normalizedRequest;
}

export function normalizeSystemBlocks( system: AnthropicMessageRequest['system'] ): { type: 'text'; text: string }[] {
    if ( !system ) {
        return [];
    }

    if ( typeof system === 'string' ) {
        return system.trim() ? [{ type: 'text', text: system }] : [];
    }

    return system
        .filter( ( block ): block is { type: 'text'; text: string } => !!block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 )
        .map( ( block ) => ( { type: 'text', text: block.text } ) );
}

export function normalizeAnthropicMessage( message: AnthropicMessageRequest['messages'][number] ): AnthropicMessageRequest['messages'][number] {
    if ( typeof message.content === 'string' ) {
        return message;
    }

    const normalizedContent: AnthropicContentBlock[] = [];

    for ( const block of message.content ) {
        if ( !block ) {
            continue;
        }

        if ( block.type === 'text' ) {
            normalizedContent.push( block );
            continue;
        }

        if ( block.type === 'image' || block.type === 'audio' || block.type === 'file' || block.type === 'document' ) {
            normalizedContent.push( block );
            continue;
        }

        if ( block.type === 'thinking' ) {
            normalizedContent.push( block );
            continue;
        }

        if ( block.type === 'tool_use' ) {
            normalizedContent.push( {
                ...block,
                id: block.id || generateUniqueToolId(),
                input: isPlainObject( block.input ) ? block.input : {},
            } );
            continue;
        }

        if ( block.type === 'tool_result' ) {
            normalizedContent.push( {
                ...block,
                content: typeof block.content === 'string'
                    ? block.content
                    : block.content.filter( ( item ): item is Extract<AnthropicContentBlock, { type: 'text' }> => !!item && item.type === 'text' ),
            } );
        }
    }

    return {
        ...message,
        content: normalizedContent,
    };
}

export function extractSystemTextFromMessageContent( content: AnthropicMessageRequest['messages'][number]['content'] ): string[] {
    if ( typeof content === 'string' ) {
        return content.trim() ? [content] : [];
    }

    return content
        .filter( ( block ): block is Extract<typeof block, { type: 'text' }> => !!block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0 )
        .map( ( block ) => block.text );
}

export function normalizeAnthropicTools( tools: AnthropicMessageRequest['tools'] ): AnthropicMessageRequest['tools'] | undefined {
    if ( !tools || tools.length === 0 ) {
        return undefined;
    }

    const hasToolSearchTool = tools.some( ( tool: any ) => isAnthropicToolSearchTool( tool ) );

    const normalizedTools = tools.flatMap( ( tool: any ) => {
        if ( !tool || typeof tool !== 'object' ) {
            return [];
        }

        if ( hasToolSearchTool && isAnthropicToolSearchTool( tool ) ) {
            return [];
        }

        if ( typeof tool.name === 'string' && tool.name.trim().length > 0 && isPlainObject( tool.input_schema ) ) {
            return [{
                name: tool.name,
                description: typeof tool.description === 'string' ? tool.description : tool.name,
                input_schema: normalizeJsonSchemaObject( tool.input_schema ),
            }];
        }

        if ( typeof tool.type === 'string' && tool.type.trim().length > 0 ) {
            const toolName = tool.type.replace( /[^a-zA-Z0-9_-]/g, '_' );
            return [{
                name: toolName,
                description: typeof tool.description === 'string' && tool.description.trim().length > 0
                    ? tool.description
                    : `Anthropic server tool: ${tool.type}`,
                input_schema: normalizeJsonSchemaObject( isPlainObject( tool.input_schema ) ? tool.input_schema : { type: 'object', properties: {} } ),
            }];
        }

        return [];
    } );

    return normalizedTools.length > 0 ? normalizedTools : undefined;
}

export function toolChoiceTargetsMissingTool( toolChoice: AnthropicMessageRequest['tool_choice'], tools: NonNullable<AnthropicMessageRequest['tools']> ): boolean {
    if ( !toolChoice || toolChoice.type !== 'tool' || typeof toolChoice.name !== 'string' || !toolChoice.name ) {
        return false;
    }

    return !tools.some( ( tool ) => tool?.name === toolChoice.name );
}

export function isAnthropicToolSearchTool( tool: Record<string, any> ): boolean {
    if ( typeof tool?.type === 'string' && /^tool_search_tool_(regex|bm25)_\d+$/.test( tool.type ) ) {
        return true;
    }

    if ( typeof tool?.name === 'string' && /^(tool_search_tool_regex|tool_search_tool_bm25)$/.test( tool.name ) ) {
        return true;
    }

    return false;
}

export function normalizeJsonSchemaObject( schema: Record<string, any> ): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
    const normalizedType = schema.type === 'object' ? 'object' : 'object';
    const properties = isPlainObject( schema.properties ) ? schema.properties : {};
    const required = Array.isArray( schema.required ) ? schema.required.filter( ( value ): value is string => typeof value === 'string' ) : undefined;

    return {
        type: normalizedType,
        properties,
        ...( required && required.length > 0 ? { required } : {} ),
    };
}

export function isPlainObject( value: unknown ): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray( value );
}
