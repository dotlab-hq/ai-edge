import { Hono } from 'hono';
import type { Context } from 'hono';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';

export class RealtimeProxy {
    private app: Hono;

    constructor() {
        this.app = new Hono();
        this.app.all( '/v1/realtime/*', ( c ) => this.proxy( c ) );
        this.app.all( '/v1/realtime', ( c ) => this.proxy( c ) );
    }

    getApp(): Hono {
        return this.app;
    }

    private getRealtimeConfig() {
        return CONFIG.realtime;
    }

    private async proxy( c: Context ): Promise<any> {
        const rt = this.getRealtimeConfig();
        if ( !rt ) {
            return c.json( { error: 'realtime is not configured' }, 503 );
        }

        try {
            const base = rt.url.replace( /\/+$/, '' );
            const upstreamPath = c.req.path; // keep full /v1/realtime/... path
            const url = `${base}${upstreamPath}`;
            const method = c.req.method;
            const headers: Record<string, string> = {
                'Authorization': `Bearer ${rt.apiKey}`,
            };

            // Forward content-type and any other relevant headers
            const contentType = c.req.header( 'content-type' );
            if ( contentType ) {
                headers[ 'Content-Type' ] = contentType;
            }
            const openAIBeta = c.req.header( 'openai-beta' );
            if ( openAIBeta ) {
                headers[ 'OpenAI-Beta' ] = openAIBeta;
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
            console.error( `[realtime] proxy error: ${error?.message || String( error )}` );
            return c.json( {
                error: {
                    message: error?.message || 'Realtime request failed',
                    type: 'upstream_error',
                },
            }, 502 );
        }
    }
}

export const realtimeProxy = new RealtimeProxy();
