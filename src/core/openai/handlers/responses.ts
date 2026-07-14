import type { Context } from 'hono';

export async function handleResponses( c: Context, delegate: ( c: Context, endpoint: string ) => Promise<any> ) {
    return delegate( c, 'responses' );
}

export async function handleResponsesCompact( c: Context ) {
    const rawBody = await c.req.json().catch( () => ( {} ) );
    const input = rawBody.input as any[] | undefined;
    const model = rawBody.model as string | undefined;

    if ( !model ) {
        return c.json( { error: { message: 'model is required', type: 'invalid_request_error' } }, 400 );
    }

    if ( !Array.isArray( input ) || input.length === 0 ) {
        return c.json( { error: { message: 'input must be a non-empty array', type: 'invalid_request_error' } }, 400 );
    }

    const systemItems: any[] = [];
    const conversationItems: any[] = [];

    for ( const item of input ) {
        const role = item?.role as string | undefined;
        if ( role === 'system' || role === 'developer' ) {
            systemItems.push( item );
        } else {
            conversationItems.push( item );
        }
    }

    const maxConversationItems = 40;
    const keptConversation = conversationItems.length > maxConversationItems
        ? conversationItems.slice( conversationItems.length - maxConversationItems )
        : conversationItems;

    const droppedCount = conversationItems.length - keptConversation.length;
    const output: any[] = [ ...systemItems ];

    if ( droppedCount > 0 ) {
        output.push( {
            type: 'message',
            role: 'user',
            content: [
                { type: 'input_text', text: `[Context compacted: ${droppedCount} earlier messages were summarized to fit within context limits.]` },
            ],
        } );
    }

    output.push( ...keptConversation );

    return c.json( {
        id: `compact_${Date.now().toString( 36 )}`,
        object: 'response.compact',
        model,
        output,
        usage: {
            input_tokens: Math.ceil( JSON.stringify( output ).length / 4 ),
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: Math.ceil( JSON.stringify( output ).length / 4 ),
        },
    } );
}
