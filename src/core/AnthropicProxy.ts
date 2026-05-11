import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { rateLimitManager } from './RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { convertAnthropicRequestToOpenAI, convertOpenAIResponseToAnthropic, streamOpenAIResponseAsAnthropic } from './AnthropicOpenAIBridge';
import type { Config } from '@/schema';
import { webSearchManager, type WebSearchResponse } from './WebSearchManager';

type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];

export class AnthropicProxy {
    private app: Hono;
    private readonly rrIndexByKey = new Map<string, number>();

    constructor() {
        this.app = new Hono();
        this.setupRoutes();
    }

    getApp(): Hono {
        return this.app;
    }

    private setupRoutes(): void {
        this.app.get( '/v1/models', ( c: Context ) => this.handleModels( c ) );
        this.app.post( '/v1/messages', ( c: Context ) => this.handleMessages( c ) );
        this.app.post( '/v1/messages/batches', ( c: Context ) => this.handleMessagesBatches( c ) );
    }

    private async handleModels( c: Context ) {
        try {
            const configs = CONFIG.models.openai;
            if ( !configs || !configs.length ) {
                console.error( '[/anthropic/v1/models] No OpenAI backend configured' );
                return c.json( { error: 'No OpenAI backend configured' }, 503 );
            }

            const firstConfig = this.getNextRoundRobinConfig( '__anthropic_models__', configs );
            if ( !firstConfig ) {
                console.error( '[/anthropic/v1/models] No backend available' );
                return c.json( { error: 'No backend configured' }, 503 );
            }

            const response = await fetchWithProxy( `${this.normalizeBaseUrl( firstConfig.baseUrl )}/v1/models`, {
                headers: this.buildHeaders( firstConfig ),
            }, CONFIG.proxy );
            const data = await response.json();
            return c.json( data, response.status as any );
        } catch ( error: any ) {
            console.error( '[/anthropic/v1/models] Exception:', error?.message || String( error ) );
            return c.json( { error: 'Failed to fetch models' }, 500 );
        }
    }

    private async handleMessages( c: Context ) {
        return this.proxyOpenAICompatibleRequest( c, 'messages' );
    }

    private async handleMessagesBatches( c: Context ) {
        return c.json( {
            error: {
                message: 'Anthropic message batches are not supported for OpenAI-compatible backends',
                type: 'invalid_request_error',
            }
        }, 501 );
    }

    private async proxyOpenAICompatibleRequest( c: Context, endpoint: string, redirectDepth: number = 1 ): Promise<any> {
        const rawBody = await c.req.json().catch( () => ( {} ) );
        const webSearchContext = await this.prepareAnthropicWebSearch( rawBody );
        if ( webSearchContext.errorResponse ) {
            return c.json( webSearchContext.errorResponse.body, webSearchContext.errorResponse.status as any );
        }

        const body = webSearchContext.body;
        const requestedModel = body.model;
        let lastFailure: { status: number; payload: any } | null = null;

        if ( !requestedModel || typeof requestedModel !== 'string' ) {
            return c.json( {
                error: {
                    message: 'Model is required and must be a string',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const maxRedirects = 5;
        if ( redirectDepth > maxRedirects ) {
            return c.json( {
                error: {
                    message: 'Maximum redirect depth exceeded',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const matchingBackends = this.getBackendsForModel( requestedModel );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No OpenAI backends found for model: ${requestedModel}` );
            return c.json( {
                error: {
                    message: `Model not found: ${requestedModel}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getRoundRobinBackends( requestedModel, matchingBackends );
        const backendIds = backends.map( b => b.id ).join( ', ' );
        console.error( `[${endpoint}] Attempting OpenAI backends for model ${requestedModel}: ${backendIds}` );

        for ( const config of backends ) {
            const candidateModels = this.getCandidateModelsForProvider( config, requestedModel );

            for ( const selectedModel of candidateModels ) {
                body.model = selectedModel;

                const tokens = this.calculateTokenCount( body );
                const rateLimit = this.getEffectiveRateLimit( config );
                const rateCheck = await rateLimitManager.checkAndConsume(
                    config.id,
                    tokens,
                    rateLimit,
                    selectedModel
                );

                if ( !rateCheck.allowed ) {
                    console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens` );
                    continue;
                }

                try {
                    const openAIRequest = convertAnthropicRequestToOpenAI( body, selectedModel, 'native' );
                    const upstreamEndpoint = this.getOpenAIEndpointForAnthropicEndpoint( endpoint );
                    const url = `${this.normalizeBaseUrl( config.baseUrl )}/v1/${upstreamEndpoint}`;
                    const response = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: this.buildHeaders( config ),
                        body: JSON.stringify( openAIRequest ),
                    }, CONFIG.proxy );

                    if ( response.status === 429 ) {
                        continue;
                    }

                    const contentType = response.headers.get( 'content-type' ) ?? '';
                    if ( openAIRequest.stream === true && response.ok && response.body && contentType.includes( 'text/event-stream' ) ) {
                        return streamOpenAIResponseAsAnthropic(
                            c,
                            response,
                            requestedModel,
                            webSearchContext.searchResponse ? this.buildAnthropicWebSearchBlocks( webSearchContext.searchResponse ) : undefined
                        );
                    }

                    const payload = await this.parseResponsePayload( response );

                    if ( !response.ok ) {
                        lastFailure = {
                            status: response.status,
                            payload,
                        };
                        console.error( `[${endpoint}] ${response.status} from ${config?.id ?? config?.name}` );
                        continue;
                    }

                    if ( !payload || typeof payload !== 'object' || Array.isArray( payload ) ) {
                        lastFailure = {
                            status: 502,
                            payload: {
                                error: {
                                    message: 'Upstream returned invalid OpenAI response',
                                    type: 'upstream_error'
                                }
                            }
                        };
                        continue;
                    }

                    const responsePayload = payload as any;
                    const promptTokens = this.calculateTokenCount( body );
                    const completionTokens = this.countTokensFromContent( responsePayload?.choices?.[0]?.message?.content ?? '' );
                    const normalizedResponse = responsePayload.usage
                        ? responsePayload
                        : {
                            ...responsePayload,
                            usage: {
                                prompt_tokens: promptTokens,
                                completion_tokens: completionTokens,
                                total_tokens: promptTokens + completionTokens,
                            },
                        };

                    const anthropicResponse = convertOpenAIResponseToAnthropic( normalizedResponse, requestedModel );
                    const responseWithWebSearch = this.attachAnthropicWebSearchMetadata( anthropicResponse, webSearchContext.searchResponse );
                    return c.json( this.attachUsageIfMissing( endpoint, body, responseWithWebSearch ), response.status as any );
                } catch ( error: any ) {
                    lastFailure = {
                        status: 502,
                        payload: {
                            error: {
                                message: error?.message || 'Upstream request failed',
                                type: 'upstream_error'
                            }
                        }
                    };
                    console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                    continue;
                }
            }
        }

        if ( lastFailure ) {
            const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
            console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
            return this.sendFailurePayload( c, lastFailure.status, lastFailure.payload );
        }

        console.error( `\n❌ [${endpoint}] ALL OPENAI PROVIDERS FAILED - No response from any backend\nModel: ${requestedModel}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private async proxyRequest( c: Context, endpoint: string, redirectDepth: number = 1 ): Promise<any> {
        const body = await c.req.json().catch( () => ( {} ) );
        const modelName = body.model;
        let lastFailure: { status: number; payload: any } | null = null;

        if ( !modelName || typeof modelName !== 'string' ) {
            return c.json( {
                error: {
                    message: 'Model is required and must be a string',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const maxRedirects = 5;
        if ( redirectDepth > maxRedirects ) {
            return c.json( {
                error: {
                    message: 'Maximum redirect depth exceeded',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const matchingBackends = this.getBackendsForModel( modelName );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No anthropic backends found for model: ${modelName}` );
            return c.json( {
                error: {
                    message: `Model not found: ${modelName}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getRoundRobinBackends( modelName, matchingBackends );
        const backendIds = backends.map( b => b.id ).join( ', ' );
        console.error( `[${endpoint}] Attempting Anthropic backends for model ${modelName}: ${backendIds}` );

        for ( const config of backends ) {
            const candidateModels = this.getCandidateModelsForProvider( config, modelName );

            for ( const selectedModel of candidateModels ) {
                body.model = selectedModel;

                const tokens = this.calculateTokenCount( body );
                const rateLimit = this.getEffectiveRateLimit( config );
                const rateCheck = await rateLimitManager.checkAndConsume(
                    config.id,
                    tokens,
                    rateLimit,
                    selectedModel
                );

                if ( !rateCheck.allowed ) {
                    console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens` );
                    continue;
                }

                try {
                    const url = `${this.normalizeBaseUrl( config.baseUrl )}/v1/${endpoint}`;
                    const response = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: this.buildHeaders( config ),
                        body: JSON.stringify( body ),
                    }, CONFIG.proxy );

                    if ( response.status === 429 ) {
                        continue;
                    }

                    // Handle streaming responses
                    if ( body.stream === true ) {
                        c.header( 'Content-Type', 'text/event-stream' );
                        c.header( 'Cache-Control', 'no-cache' );
                        c.header( 'Connection', 'keep-alive' );

                        if ( response.body ) {
                            return stream( c, async ( streamWriter ) => {
                                const reader = response.body!.getReader();
                                const decoder = new TextDecoder();

                                try {
                                    while ( true ) {
                                        const { done, value } = await reader.read();
                                        if ( done ) break;
                                        const chunk = decoder.decode( value, { stream: true } );
                                        await streamWriter.write( chunk );
                                    }
                                } finally {
                                    reader.releaseLock();
                                }
                            }, async ( err, streamWriter ) => {
                                console.error( `[${endpoint}] Streaming error: ${err?.message || String( err )}` );
                                await streamWriter.writeln( 'An error occurred during streaming' );
                            } );
                        }
                    }

                    const payload = await this.parseResponsePayload( response );

                    if ( !response.ok ) {
                        lastFailure = {
                            status: response.status,
                            payload,
                        };
                        console.error( `[${endpoint}] ${response.status} from ${config?.id ?? config?.name}` );
                        continue;
                    }

                    return c.json( this.attachUsageIfMissing( endpoint, body, payload ), response.status as any );
                } catch ( error: any ) {
                    lastFailure = {
                        status: 502,
                        payload: {
                            error: {
                                message: error?.message || 'Upstream request failed',
                                type: 'upstream_error'
                            }
                        }
                    };
                    console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                    continue;
                }
            }
        }

        if ( lastFailure ) {
            const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
            console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
            return this.sendFailurePayload( c, lastFailure.status, lastFailure.payload );
        }

        console.error( `\n❌ [${endpoint}] ALL ANTHROPIC PROVIDERS FAILED - No response from any backend\nModel: ${modelName}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private getBackendsForModel( modelName: string ): OpenAIModelConfig[] {
        return ( CONFIG.models.openai || [] ).filter( config => {
            const matchesRequestedModel = config.models.some( m => m === modelName );
            const canRouteWithoutModelMatch = config.randomRouting === true;
            return matchesRequestedModel || canRouteWithoutModelMatch;
        } );
    }

    private async prepareAnthropicWebSearch( body: any ): Promise<{
        body: any;
        searchResponse?: WebSearchResponse;
        errorResponse?: { status: number; body: any };
    }> {
        if ( !this.shouldUseAnthropicWebSearch( body ) ) {
            return { body };
        }

        if ( !webSearchManager.isEnabled() ) {
            return {
                body,
                errorResponse: {
                    status: 503,
                    body: {
                        error: {
                            message: 'Web search requested but no web search provider is configured',
                            type: 'invalid_request_error',
                        }
                    }
                }
            };
        }

        const query = this.extractAnthropicWebSearchQuery( body );
        if ( !query ) {
            return {
                body,
                errorResponse: {
                    status: 400,
                    body: {
                        error: {
                            message: 'Unable to derive a web search query from the Anthropic messages payload',
                            type: 'invalid_request_error',
                        }
                    }
                }
            };
        }

        const searchResponse = await webSearchManager.search( query, {
            maxResults: 8,
        } );
        return {
            body: this.injectAnthropicWebSearchContext( body, searchResponse ),
            searchResponse,
        };
    }

    private shouldUseAnthropicWebSearch( body: any ): boolean {
        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        return tools.some( ( tool: any ) =>
            tool?.name === 'web_search'
            || ( typeof tool?.type === 'string' && tool.type.startsWith( 'web_search_' ) )
            || tool?.type === 'web_search'
        );
    }

    private extractAnthropicWebSearchQuery( body: any ): string | null {
        const messages = Array.isArray( body?.messages ) ? body.messages : [];
        for ( let index = messages.length - 1; index >= 0; index -= 1 ) {
            const message = messages[index];
            if ( message?.role !== 'user' ) continue;
            const text = this.extractAnthropicTextContent( message?.content );
            if ( text ) return text;
        }
        return null;
    }

    private injectAnthropicWebSearchContext( body: any, searchResponse: WebSearchResponse ): any {
        const searchPrompt = this.buildAnthropicWebSearchPrompt( searchResponse );
        const existingSystem = body?.system;
        const systemBlocks = typeof existingSystem === 'string'
            ? [{ type: 'text', text: existingSystem }]
            : Array.isArray( existingSystem ) ? existingSystem : [];

        return {
            ...body,
            tools: Array.isArray( body?.tools )
                ? body.tools.filter( ( tool: any ) =>
                    tool?.name !== 'web_search'
                    && tool?.type !== 'web_search'
                    && !( typeof tool?.type === 'string' && tool.type.startsWith( 'web_search_' ) )
                )
                : body?.tools,
            system: [
                ...systemBlocks,
                {
                    type: 'text',
                    text: searchPrompt,
                },
            ],
        };
    }

    private buildAnthropicWebSearchPrompt( searchResponse: WebSearchResponse ): string {
        const citations = searchResponse.citations
            .map( ( citation, index ) => `[${index + 1}] ${citation.title} - ${citation.url}\n${citation.snippet}` )
            .join( '\n\n' );

        return [
            `Web search results for query: ${searchResponse.query}`,
            'Use these results while answering. Cite supporting sources inline as [1], [2], etc.',
            citations,
        ].join( '\n\n' );
    }

    private attachAnthropicWebSearchMetadata( payload: any, searchResponse?: WebSearchResponse ): any {
        if ( !searchResponse || !payload || typeof payload !== 'object' || !Array.isArray( payload.content ) ) {
            return payload;
        }

        const webSearchBlocks = this.buildAnthropicWebSearchBlocks( searchResponse );

        return {
            ...payload,
            content: [
                ...webSearchBlocks,
                ...payload.content,
            ],
            usage: this.attachAnthropicWebSearchUsage( payload.usage ),
        };
    }

    private buildAnthropicWebSearchBlocks( searchResponse: WebSearchResponse ): any[] {
        const toolUseId = `srvtoolu_${Date.now().toString( 36 )}`;
        const toolResultContent = searchResponse.citations.map( ( citation ) => ( {
            type: 'web_search_result',
            url: citation.url,
            title: citation.title,
            encrypted_content: this.buildWebSearchEncryptedContent( citation.title, citation.url, citation.snippet ),
        } ) );

        return [
            {
                type: 'server_tool_use',
                id: toolUseId,
                name: 'web_search',
                input: {
                    query: searchResponse.query,
                },
            },
            {
                type: 'web_search_tool_result',
                tool_use_id: toolUseId,
                content: toolResultContent,
            },
        ];
    }

    private attachAnthropicWebSearchUsage( usage: any ): any {
        const baseUsage = usage && typeof usage === 'object' ? { ...usage } : {};
        return {
            ...baseUsage,
            server_tool_use: {
                ...( baseUsage.server_tool_use ?? {} ),
                web_search_requests: ( baseUsage.server_tool_use?.web_search_requests ?? 0 ) + 1,
            },
        };
    }

    private buildWebSearchEncryptedContent( title: string, url: string, snippet: string ): string {
        return Buffer.from( JSON.stringify( { title, url, snippet } ) ).toString( 'base64' );
    }

    private formatAnthropicWebSearchResult( searchResponse: WebSearchResponse ): string {
        const sources = searchResponse.citations
            .map( ( citation, index ) => `[${index + 1}] ${citation.title}\n${citation.url}\n${citation.snippet}` )
            .join( '\n\n' );

        return [
            `Provider: ${searchResponse.provider}`,
            `Query: ${searchResponse.query}`,
            `Cached: ${searchResponse.cached ? 'yes' : 'no'}`,
            searchResponse.answerText,
            sources,
        ].filter( Boolean ).join( '\n\n' );
    }

    private extractAnthropicTextContent( content: any ): string {
        if ( typeof content === 'string' ) {
            return content.trim();
        }
        if ( !Array.isArray( content ) ) {
            return '';
        }
        return content
            .filter( ( block: any ) => block?.type === 'text' && typeof block?.text === 'string' )
            .map( ( block: any ) => block.text )
            .join( ' ' )
            .trim();
    }

    private getOpenAIEndpointForAnthropicEndpoint( endpoint: string ): string {
        if ( endpoint === 'messages' ) {
            return 'chat/completions';
        }

        throw new Error( `Unsupported Anthropic endpoint mapping: ${endpoint}` );
    }

    private getRoundRobinBackends( modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
        if ( backends.length <= 1 ) {
            return backends;
        }

        const key = `anthropic:model:${modelName}`;
        const startIndex = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return [
            ...backends.slice( startIndex ),
            ...backends.slice( 0, startIndex ),
        ];
    }

    private getNextRoundRobinConfig( key: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig | undefined {
        if ( !backends.length ) {
            return undefined;
        }

        const index = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return backends[index];
    }

    private getAndIncrementRoundRobinIndex( key: string, total: number ): number {
        if ( total <= 0 ) {
            return 0;
        }

        const current = this.rrIndexByKey.get( key ) ?? 0;
        const index = current % total;
        this.rrIndexByKey.set( key, ( index + 1 ) % total );
        return index;
    }

    private buildHeaders( config: OpenAIModelConfig ): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
            'User-Agent': 'ai-edge/1.0',
        };
    }

    private getCandidateModelsForProvider( config: OpenAIModelConfig, requestedModel: string ): string[] {
        if ( !config.randomRouting ) {
            return [requestedModel];
        }

        const uniqueModels: string[] = Array.from( new Set( config.models ) );
        if ( !uniqueModels.length ) {
            return [requestedModel];
        }

        const startIndex = Math.floor( Math.random() * uniqueModels.length );
        return [
            ...uniqueModels.slice( startIndex ),
            ...uniqueModels.slice( 0, startIndex ),
        ];
    }

    private getEffectiveRateLimit( config: OpenAIModelConfig ): Config['rateLimit'] | undefined {
        if ( config.individualLimit && config.rateLimit ) {
            return config.rateLimit;
        }
        return CONFIG.rateLimit;
    }

    private async parseResponsePayload( response: Response ): Promise<any> {
        const contentType = response.headers.get( 'content-type' ) ?? '';

        if ( contentType.includes( 'application/json' ) ) {
            return response.json().catch( () => ( {
                error: {
                    message: 'Upstream returned invalid JSON',
                    type: 'upstream_error'
                }
            } ) );
        }

        const text = await response.text().catch( () => '' );
        if ( !text ) {
            return {
                error: {
                    message: response.statusText || 'Upstream request failed',
                    type: 'upstream_error'
                }
            };
        }

        return text;
    }

    private sendFailurePayload( c: Context, status: number, payload: any ) {
        if ( payload && typeof payload === 'object' ) {
            return c.json( payload, status as any );
        }
        return c.text( String( payload ?? 'Upstream request failed' ), status as any );
    }

    private normalizeBaseUrl( baseUrl: string ): string {
        const trimmed = baseUrl.replace( /\/+$/, '' );
        if ( trimmed.endsWith( '/v1' ) ) {
            return trimmed.slice( 0, -3 );
        }
        return trimmed;
    }

    private calculateTokenCount( body: any ): number {
        if ( !body ) return 0;

        let totalTokens = 0;

        // Count tokens from messages
        if ( body.messages && Array.isArray( body.messages ) ) {
            for ( const msg of body.messages ) {
                totalTokens += this.countTokensFromContent( msg.content );
                if ( msg.tool_calls ) {
                    for ( const tool of msg.tool_calls ) {
                        totalTokens += Math.max( 1, Math.ceil( JSON.stringify( tool.function.arguments ).length / 4 ) );
                    }
                }
            }
        }

        // Count tokens from system
        if ( body.system ) {
            totalTokens += this.countTokensFromContent( body.system );
        }

        // Fallback
        if ( totalTokens === 0 ) {
            totalTokens = 100;
        }

        return totalTokens;
    }

    private countTokensFromContent( content: any ): number {
        if ( typeof content === 'string' ) {
            return Math.max( 1, Math.ceil( content.length / 4 ) );
        }
        if ( Array.isArray( content ) ) {
            return content.reduce( ( sum: number, block: any ) => {
                if ( block.type === 'text' && block.text ) {
                    return sum + Math.max( 1, Math.ceil( block.text.length / 4 ) );
                }
                return sum;
            }, 0 );
        }
        return 0;
    }

    private attachUsageIfMissing( endpoint: string, requestBody: any, responseData: any ): any {
        if ( !responseData || typeof responseData !== 'object' || Array.isArray( responseData ) ) {
            return responseData;
        }

        if ( responseData.usage ) {
            return responseData;
        }

        const promptTokens = this.calculateTokenCount( requestBody );
        const completionTokens = this.countTokensFromContent(
            responseData.content || responseData.output || ''
        );

        return {
            ...responseData,
            usage: {
                input_tokens: promptTokens,
                output_tokens: completionTokens,
            },
        };
    }
}

export const anthropicProxy = new AnthropicProxy();
