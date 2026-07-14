import { fileSearchManager, type FileSearchResponse } from '../FileSearchManager';
import type { FileSearchCallItem } from '../ResponsesConversion';

export function shouldUseFileSearch( body: any ): boolean {
    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    return tools.some( ( tool: any ) => tool?.type === 'file_search' );
}

export function collectTextFromContent( content: unknown ): string {
    if ( typeof content === 'string' ) return content.trim();
    if ( !Array.isArray( content ) ) return '';
    const parts: string[] = [];
    for ( const block of content ) {
        if ( !block || typeof block !== 'object' ) continue;
        const t = block.type as string;
        if ( ( t === 'input_text' || t === 'text' ) && typeof block.text === 'string' ) parts.push( block.text );
        else if ( typeof block.text === 'string' ) parts.push( block.text );
    }
    return parts.join( '\n' ).trim();
}

export function extractFileSearchQueries( body: any ): string[] {
    const inputItems = Array.isArray( body?.input ) ? body.input : ( body?.input ? [body.input] : [] );
    const queries: string[] = [];

    for ( let i = inputItems.length - 1; i >= 0; i-- ) {
        const item = inputItems[i];
        if ( !item || typeof item !== 'object' ) continue;
        if ( item.role === 'user' || item.role === 'developer' ) {
            const text = collectTextFromContent( item.content );
            if ( text ) { queries.push( text ); break; }
        }
    }

    if ( !queries.length ) {
        for ( const item of inputItems ) {
            if ( !item || typeof item !== 'object' ) continue;
            const text = collectTextFromContent( item.content );
            if ( text ) { queries.push( text ); break; }
        }
    }
    return queries.slice( 0, 5 );
}

export function stripFileSearchTools( body: any ): any {
    if ( !Array.isArray( body?.tools ) ) return body;
    return { ...body, tools: body.tools.filter( ( t: any ) => t?.type !== 'file_search' ) };
}

export function injectFileSearchContext( body: any, queries: string[], searchResponse: FileSearchResponse ): any {
    const snippets = searchResponse.results.map( ( r, i ) => {
        const fileRef = r.filename ? `[File: ${r.filename}]` : `[File ID: ${r.file_id}]`;
        const score = typeof r.score === 'number' ? ` (score: ${r.score.toFixed( 2 )})` : '';
        return `${fileRef}${score}\n${r.text}`;
    } );

    const fileSearchContext = [
        `File search results for query: ${queries.join( '; ' )}`,
        'Use these file excerpts as context when answering. Cite sources by filename when relevant.',
        snippets.join( '\n\n---\n\n' ),
    ].join( '\n\n' );

    const inputItems = Array.isArray( body?.input ) ? [...body.input] : ( body?.input ? [body.input] : [] );
    inputItems.push( { role: 'system', content: [ { type: 'input_text', text: fileSearchContext } ] } );
    return { ...body, input: inputItems };
}

export async function prepareFileSearchForResponses( body: any ): Promise<{ body: any; searchCalls?: FileSearchCallItem[] }> {
    if ( !shouldUseFileSearch( body ) ) return { body };

    if ( !fileSearchManager.isEnabled() ) {
        console.warn( `[file-search] file_search tool requested but vector store is not configured — stripping tool` );
        return { body: stripFileSearchTools( body ) };
    }

    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    const fileSearchTools = tools.filter( ( t: any ) => t?.type === 'file_search' );

    const queries = extractFileSearchQueries( body );
    if ( !queries.length ) {
        console.warn( `[file-search] No queries derivable from input — stripping file_search tool` );
        return { body: stripFileSearchTools( body ) };
    }

    const vectorStoreIds: string[] = [];
    for ( const tool of fileSearchTools ) {
        const ids = Array.isArray( tool.vector_store_ids ) ? tool.vector_store_ids : [];
        for ( const id of ids ) if ( typeof id === 'string' && !vectorStoreIds.includes( id ) ) vectorStoreIds.push( id );
    }

    const maxResults = Math.max( ...fileSearchTools.map( ( t: any ) => t?.max_num_results ?? 20 ), 20 );

    try {
        const searchResponse = await fileSearchManager.search( queries, vectorStoreIds, { maxResults } );
        const searchCallId = `fs_${Date.now().toString( 36 )}`;
        const searchCall: FileSearchCallItem = { id: searchCallId, queries, status: 'completed', results: searchResponse.results };
        const enrichedBody = injectFileSearchContext( stripFileSearchTools( body ), queries, searchResponse );
        return { body: enrichedBody, searchCalls: [searchCall] };
    } catch ( err: any ) {
        console.error( `[file-search] search_error error=${err?.message || String( err )}` );
        return { body: stripFileSearchTools( body ) };
    }
}
