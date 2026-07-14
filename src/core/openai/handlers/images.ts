import type { Context } from 'hono';
import type { BackendState } from '../types';
import { runProxyRequest } from '../providerLoop';

export async function handleImageGenerations( c: Context, state: BackendState ) {
    return runProxyRequest( { c, state, endpoint: 'images/generations' } ).then( r => r.response );
}

export async function handleImageEdits( c: Context, state: BackendState ) {
    return runProxyRequest( { c, state, endpoint: 'images/edits' } ).then( r => r.response );
}
