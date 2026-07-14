import type { Context } from 'hono';
import type { BackendState } from '../types';
import { runProxyRequest } from '../providerLoop';

/**
 * POST /v1/embeddings
 * Embeds are routed to embeddings-capable backends and proxied directly.
 */
export async function handleEmbeddings( c: Context, state: BackendState ) {
    return runProxyRequest( { c, state, endpoint: 'embeddings' } ).then( r => r.response );
}
