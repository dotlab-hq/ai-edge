// Internal helpers shared across Responses conversion modules.

import type { ResponsesRequest, ChatTool } from './types';

let idCounter = 0;

export function generateId( prefix: string ): string {
    const ts = Date.now().toString( 36 );
    const seq = ( ++idCounter ).toString( 36 ).padStart( 4, '0' );
    const rand = Math.random().toString( 36 ).substring( 2, 8 );
    return `${prefix}_${ts}${seq}${rand}`;
}

export function buildEmptyUsage(): Record<string, unknown> {
    return {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
    };
}

export function normaliseInputItems( input: unknown ): Array<Record<string, unknown>> {
    if ( input == null ) return [];
    if ( typeof input === 'string' ) return [{ role: 'user', content: input } as Record<string, unknown>];
    if ( Array.isArray( input ) ) return input as Array<Record<string, unknown>>;
    return [];
}

export function extractToolCallsFromAssistantItem( item: Record<string, unknown> ): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
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

export function convertToolsToChat( tools?: Array<Record<string, unknown>> ): ChatTool[] {
    if ( !tools || tools.length === 0 ) return [];

    return tools
        .filter( ( tool ) => {
            const t = tool.type as string;
            return t === 'function' || ( !t && typeof tool.function === 'object' );
        } )
        .map( ( tool ) => {
            const fn = ( tool.function ?? tool ) as Record<string, unknown>;
            const entry: ChatTool = {
                type: 'function' as const,
                function: {
                    name: ( fn.name as string ) || '',
                    description: typeof fn.description === 'string' ? fn.description : undefined,
                    parameters: typeof fn.parameters === 'object' && fn.parameters !== null
                        ? fn.parameters as Record<string, unknown>
                        : undefined,
                },
            };
            if ( typeof fn.strict === 'boolean' ) entry.function.strict = fn.strict;
            return entry;
        } );
}

export function convertToolChoiceToChat( toolChoice: unknown ): unknown {
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

export function resolveReasoningEffort( request: ResponsesRequest ): string | undefined {
    if ( typeof request.reasoning_effort === 'string' ) return request.reasoning_effort;

    const reasoning = request.reasoning as Record<string, unknown> | undefined;
    if ( reasoning && typeof reasoning === 'object' ) {
        const summary = reasoning.summary as string | undefined;
        if ( summary === 'none' ) return undefined;
        if ( summary === 'detailed' ) return 'high';
        if ( summary === 'auto' ) return undefined;
    }

    return undefined;
}
