import type { Context } from 'hono';
import { webSearchManager, type WebSearchResponse } from '../WebSearchManager';
import { CONFIG } from '@/utils/schema.lookup';
import { collectTokenStrings } from './helpers';

// ── normalizeToolSearchForEndpoint ─────────────────────────────

export function normalizeToolSearchForEndpoint( body: any, endpoint: string ): any {
    if ( !Array.isArray( body?.tools ) ) return body;

    const normalizedTools = body.tools
        .filter( ( tool: any ) => tool?.type !== 'tool_search' )
        .map( ( tool: any ) => removeDeferLoadingField( tool ) );

    const changed = normalizedTools.length !== body.tools.length
        || normalizedTools.some( ( tool: any, index: number ) => tool !== body.tools[index] );

    if ( !changed ) return body;

    const normalizedBody: any = { ...body, tools: normalizedTools };
    if ( toolChoicePointsToMissingTool( normalizedBody.tool_choice, normalizedTools ) ) {
        delete normalizedBody.tool_choice;
    }
    return normalizedBody;
}

function removeDeferLoadingField( tool: any ): any {
    if ( !tool || typeof tool !== 'object' ) return tool;
    let changed = false;
    const nextTool = { ...tool } as Record<string, any>;

    if ( Object.prototype.hasOwnProperty.call( nextTool, 'defer_loading' ) ) { delete nextTool.defer_loading; changed = true; }
    if ( nextTool.function && typeof nextTool.function === 'object' && !Array.isArray( nextTool.function ) ) {
        const fn = { ...nextTool.function } as Record<string, any>;
        if ( Object.prototype.hasOwnProperty.call( fn, 'defer_loading' ) ) { delete fn.defer_loading; nextTool.function = fn; changed = true; }
    }
    return changed ? nextTool : tool;
}

function toolChoicePointsToMissingTool( toolChoice: any, tools: any[] ): boolean {
    if ( !toolChoice || typeof toolChoice !== 'object' ) return false;
    const selectedName = toolChoice?.function?.name;
    if ( typeof selectedName !== 'string' || !selectedName ) return false;
    const available = new Set<string>();
    for ( const tool of tools ) {
        if ( typeof tool?.function?.name === 'string' && tool.function.name ) available.add( tool.function.name );
        else if ( typeof tool?.name === 'string' && tool.name ) available.add( tool.name );
    }
    return !available.has( selectedName );
}

// ── Web search prep ────────────────────────────────────────────

export function shouldUseOpenAIWebSearch( body: any ): boolean {
    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    return tools.some( ( tool: any ) => tool?.type === 'web_search' || tool?.type === 'web_search_preview' );
}

export function extractOpenAIWebSearchQuery( body: any, endpoint: string ): string | null {
    if ( endpoint === 'responses' ) {
        return collectTokenStrings( body?.input ).join( ' ' ).trim() || null;
    }
    if ( endpoint === 'chat/completions' ) {
        const messages = Array.isArray( body?.messages ) ? body.messages : [];
        for ( let index = messages.length - 1; index >= 0; index -= 1 ) {
            const message = messages[index];
            if ( message?.role !== 'user' ) continue;
            const text = collectTokenStrings( message?.content ).join( ' ' ).trim();
            if ( text ) return text;
        }
    }
    return null;
}

export function injectOpenAIWebSearchContext( body: any, endpoint: string, searchResponse: WebSearchResponse ): any {
    const toolFreeBody = {
        ...body,
        tools: Array.isArray( body?.tools )
            ? body.tools.filter( ( tool: any ) => tool?.type !== 'web_search' && tool?.type !== 'web_search_preview' )
            : body?.tools,
    };
    const searchPrompt = buildOpenAIWebSearchPrompt( searchResponse );

    if ( endpoint === 'responses' ) {
        return {
            ...toolFreeBody,
            input: [
                ...( Array.isArray( toolFreeBody.input ) ? toolFreeBody.input : [toolFreeBody.input].filter( Boolean ) ),
                { role: 'system', content: [ { type: 'input_text', text: searchPrompt } ] },
            ],
        };
    }
    if ( endpoint === 'chat/completions' ) {
        return {
            ...toolFreeBody,
            messages: [ { role: 'system', content: searchPrompt }, ...( Array.isArray( toolFreeBody.messages ) ? toolFreeBody.messages : [] ) ],
        };
    }
    return toolFreeBody;
}

function buildOpenAIWebSearchPrompt( searchResponse: WebSearchResponse ): string {
    const citations = searchResponse.citations
        .map( ( citation, index ) => `[${index + 1}] ${citation.title} - ${citation.url}\n${citation.snippet}` )
        .join( '\n\n' );
    return [
        `Web search results for query: ${searchResponse.query}`,
        'Use these sources when answering. Cite them inline as [1], [2], etc when relevant.',
        citations,
    ].join( '\n\n' );
}

export function attachWebSearchMetadata( endpoint: string, payload: any, searchResponse?: WebSearchResponse ): any {
    if ( !searchResponse || !payload || typeof payload !== 'object' || Array.isArray( payload ) ) return payload;
    if ( endpoint === 'responses' ) {
        const output = Array.isArray( payload.output ) ? payload.output : [];
        return {
            ...payload,
            output: [
                { type: 'web_search_call', id: `ws_${Date.now().toString( 36 )}`, status: 'completed', action: { type: 'search', query: searchResponse.query } },
                ...output,
            ],
            web_search: { provider: searchResponse.provider, citations: searchResponse.citations, cached: searchResponse.cached },
        };
    }
    return { ...payload, web_search: { provider: searchResponse.provider, citations: searchResponse.citations, cached: searchResponse.cached } };
}

export async function prepareWebSearchForOpenAI( body: any, endpoint: string ): Promise<{
    body: any;
    searchResponse?: WebSearchResponse;
    errorResponse?: { status: number; body: any };
}> {
    if ( !shouldUseOpenAIWebSearch( body ) ) return { body };

    if ( !webSearchManager.isEnabled() ) {
        return { body, errorResponse: { status: 503, body: { error: { message: 'Web search requested but no web search provider is configured', type: 'invalid_request_error' } } } };
    }

    const query = extractOpenAIWebSearchQuery( body, endpoint );
    if ( !query ) {
        return { body, errorResponse: { status: 400, body: { error: { message: 'Unable to derive a web search query from the request', type: 'invalid_request_error' } } } };
    }

    const searchDefaults = CONFIG.tools?.webSearch?.defaults;
    const searchResponse = await webSearchManager.search( query, {
        maxResults: searchDefaults?.maxResults ?? 6,
        expand: searchDefaults?.expandQueries,
        maxExpandedQueries: searchDefaults?.maxExpandedQueries,
        parallelQueries: searchDefaults?.parallelQueries,
        softTimeoutMs: searchDefaults?.softTimeoutMs,
        providerTimeoutMs: searchDefaults?.providerTimeoutMs,
    } );
    return { body: injectOpenAIWebSearchContext( body, endpoint, searchResponse ), searchResponse };
}
