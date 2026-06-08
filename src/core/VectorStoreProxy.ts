import { Hono } from 'hono';
import type { Context } from 'hono';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';

export class VectorStoreProxy {
    private app: Hono;

    constructor() {
        this.app = new Hono();
        this.app.all( '/vector_stores/*', ( c ) => this.proxy( c ) );
        this.app.all( '/vector_stores', ( c ) => this.proxy( c ) );
        this.app.all( '/files/*', ( c ) => this.proxy( c ) );
        this.app.all( '/files', ( c ) => this.proxy( c ) );
        this.app.all( '/v1/vector_stores/*', ( c ) => this.proxy( c ) );
        this.app.all( '/v1/vector_stores', ( c ) => this.proxy( c ) );
        this.app.all( '/v1/files/*', ( c ) => this.proxy( c ) );
        this.app.all( '/v1/files', ( c ) => this.proxy( c ) );
    }

    getApp(): Hono {
        return this.app;
    }

    private getVsConfig() {
        return CONFIG.vectorStore;
    }

    private async proxy( c: Context ): Promise<any> {
        const vs = this.getVsConfig();
        if ( !vs ) {
            return c.json( { error: 'vectorStore is not configured' }, 503 );
        }

        try {
            const base = vs.url.replace( /\/+$/, '' );
            const url = `${base}${c.req.path}`;
            const method = c.req.method;
            const headers: Record<string, string> = {
                'Authorization': `Bearer ${vs.apiKey}`,
            };

            const contentType = c.req.header( 'content-type' );
            if ( contentType ) {
                headers[ 'Content-Type' ] = contentType;
            }

            let body: any = undefined;
            if ( method !== 'GET' && method !== 'HEAD' ) {
                const arrayBuffer = await c.req.arrayBuffer();
                if ( arrayBuffer.byteLength > 0 ) {
                    body = arrayBuffer;
                }
            }

            const upstreamResponse = await fetchWithProxy( url, { method, headers, body }, CONFIG.proxy );
            const upstreamContentType = upstreamResponse.headers.get( 'content-type' ) || 'application/json';
            const responseBuffer = await upstreamResponse.arrayBuffer();

            c.header( 'Content-Type', upstreamContentType );
            return c.body( responseBuffer, upstreamResponse.status as any );
        } catch ( error: any ) {
            console.error( `[vectorStore] proxy error: ${error?.message || String( error )}` );
            return c.json( {
                error: {
                    message: error?.message || 'Vector store request failed',
                    type: 'upstream_error',
                },
            }, 502 );
        }
    }
}

export const vectorStoreProxy = new VectorStoreProxy();
