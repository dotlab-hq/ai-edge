import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { rateLimitManager } from './RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import type { Config } from '@/schema';

type OpenAIModelConfig = Config['models']['openai'][0];

export class OpenAIProxy {
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
        this.app.post( '/v1/responses', ( c: Context ) => this.handleResponses( c ) );
        this.app.post( '/v1/chat/completions', ( c: Context ) => this.handleChatCompletions( c ) );
        this.app.post( '/v1/embeddings', ( c: Context ) => this.handleEmbeddings( c ) );
        this.app.post( '/v1/completions', ( c: Context ) => this.handleCompletions( c ) );
        this.app.post( '/v1/images/generations', ( c: Context ) => this.handleImageGenerations( c ) );
        this.app.post( '/v1/images/edits', ( c: Context ) => this.handleImageEdits( c ) );
    }

    private async handleModels( c: Context ) {
        try {
            const configs = CONFIG.models.openai;
            if ( !configs.length ) {
                console.error( '[/v1/models] No backend configured' );
                return c.json( { error: 'No backend configured' }, 503 );
            }

            const firstConfig = this.getNextRoundRobinConfig( '__models__', configs );
            if ( !firstConfig ) {
                console.error( '[/v1/models] No backend available' );
                return c.json( { error: 'No backend configured' }, 503 );
            }

            const response = await fetchWithProxy( this.buildApiUrl( firstConfig, 'models' ), {
                headers: this.buildHeaders( firstConfig ),
            }, CONFIG.proxy );
            const data = await response.json();
            return c.json( data, response.status as any );
        } catch ( error: any ) {
            console.error( '[/v1/models] Exception:', error?.message || String( error ) );
            return c.json( { error: 'Failed to fetch models' }, 500 );
        }
    }

    private async handleResponses( c: Context ) {
        return this.proxyRequest( c, 'responses' );
    }

    private async handleChatCompletions( c: Context ) {
        return this.proxyRequest( c, 'chat/completions' );
    }

    private async handleEmbeddings( c: Context ) {
        return this.proxyRequest( c, 'embeddings' );
    }

    private async handleCompletions( c: Context ) {
        return this.proxyRequest( c, 'completions' );
    }

    private async handleImageGenerations( c: Context ) {
        return this.proxyRequest( c, 'images/generations' );
    }

    private async handleImageEdits( c: Context ) {
        return this.proxyRequest( c, 'images/edits' );
    }

    private getEffectiveRateLimit( config: OpenAIModelConfig ): Config['rateLimit'] | undefined {
        if ( config.individualLimit && config.rateLimit ) {
            return config.rateLimit;
        }
        return CONFIG.rateLimit;
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

        const matchingBackends = this.getBackendsForModel( modelName, endpoint );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No backends found for model: ${modelName}` );
            return c.json( {
                error: {
                    message: `Model not found: ${modelName}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getRoundRobinBackends( modelName, matchingBackends );
        const backendIds = backends.map( b => b.id ).join( ', ' );
        console.error( `[${endpoint}] Attempting backends for model ${modelName}: ${backendIds}` );

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
                    console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens, limit: ${rateLimit?.tokensPerMinute || rateLimit?.requestsPerMinute || 'unknown'}/min` );
                    continue;
                }

                try {
                    const url = this.buildApiUrl( config, endpoint );
                    const response = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: this.buildHeaders( config ),
                        body: JSON.stringify( body ),
                    }, CONFIG.proxy );

                    if ( response.status === 429 ) {
                        continue;
                    }

                    if ( this.isRedirectStatus( response.status ) ) {
                        const location = response.headers.get( 'location' );
                        if ( location ) {
                            const redirectModel = this.extractModelFromLocation( location );
                            if ( redirectModel && redirectModel !== modelName ) {
                                body.model = redirectModel;
                                return this.proxyRequest( c, endpoint, redirectDepth + 1 );
                            }
                        }
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

        console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED - No response from any backend\nModel: ${modelName}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private isRedirectStatus( status: number ): boolean {
        return [301, 302, 303, 307, 308].includes( status );
    }

    private extractModelFromLocation( location: string ): string | null {
        try {
            if ( location.includes( 'kilo-auto/' ) ) {
                const match = location.match( /kilo-auto\/([^/]+)/ );
                if ( match ) {
                    return `kilo-auto/${match[1]}`;
                }
            }
            const parts = location.split( '/' );
            const lastPart = parts[parts.length - 1];
            if ( lastPart && lastPart.length > 0 ) {
                return lastPart;
            }
        } catch {
            return null;
        }
        return null;
    }

    private getBackendsForModel( modelName: string, endpoint?: string ): OpenAIModelConfig[] {
        return CONFIG.models.openai.filter( config => {
            const matchesRequestedModel = config.models.some( m => m === modelName );
            const canRouteWithoutModelMatch = config.randomRouting === true;

            // For image endpoints, filter by capability and allow random routing
            if ( endpoint === 'images/generations' ) {
                if ( !this.isImageGenerationEnabled( config ) ) return false;
                return matchesRequestedModel || canRouteWithoutModelMatch;
            }

            if ( endpoint === 'images/edits' ) {
                if ( !this.isImageEditingEnabled( config ) ) return false;
                return matchesRequestedModel || canRouteWithoutModelMatch;
            }

            // For chat/completions/responses, exclude providers marked as imageModels only
            if ( endpoint === 'chat/completions' || endpoint === 'completions' || endpoint === 'responses' ) {
                if ( this.isImageOnlyConfig( config ) ) return false;
                return matchesRequestedModel || canRouteWithoutModelMatch;
            }

            return matchesRequestedModel || canRouteWithoutModelMatch;
        } );
    }

    private isImageGenerationEnabled( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        if ( typeof imageModels === 'boolean' ) {
            return imageModels;
        }
        return imageModels?.image_generation === true;
    }

    private isImageEditingEnabled( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        if ( typeof imageModels === 'boolean' ) {
            return imageModels;
        }
        return imageModels?.image_editing === true;
    }

    private isImageOnlyConfig( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        if ( typeof imageModels === 'boolean' ) {
            return imageModels;
        }
        return imageModels?.image_generation === true || imageModels?.image_editing === true;
    }

    private getRoundRobinBackends( modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
        if ( backends.length <= 1 ) {
            return backends;
        }

        const key = `model:${modelName}`;
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

        const uniqueModels = Array.from( new Set( config.models ) );
        if ( !uniqueModels.length ) {
            return [requestedModel];
        }

        const startIndex = Math.floor( Math.random() * uniqueModels.length );
        return [
            ...uniqueModels.slice( startIndex ),
            ...uniqueModels.slice( 0, startIndex ),
        ];
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

    private buildApiUrl( config: OpenAIModelConfig, endpoint: string ): string {
        const baseUrl = this.normalizeBaseUrl( config.baseUrl );
        return `${baseUrl}/v1/${endpoint}`;
    }

    private normalizeBaseUrl( baseUrl: string ): string {
        const trimmed = baseUrl.replace( /\/+$/, '' );
        if ( trimmed.endsWith( '/v1' ) ) {
            return trimmed.slice( 0, -3 );
        }
        return trimmed;
    }

    private calculateTokenCount( body: any ): number {
        if ( body?.input !== undefined ) {
            const embeddingTokens = this.calculateEmbeddingTokenCount( body.input );
            if ( embeddingTokens > 0 ) {
                return embeddingTokens;
            }
        }

        return this.calculateTokenCountFromStrings( this.extractRequestTokenStrings( body ) );
    }

    private attachUsageIfMissing( endpoint: string, requestBody: any, responseData: any ): any {
        if ( !responseData || typeof responseData !== 'object' || Array.isArray( responseData ) ) {
            return responseData;
        }

        if ( responseData.usage ) {
            return responseData;
        }

        const usage = this.buildUsageForEndpoint( endpoint, requestBody, responseData );
        if ( !usage ) {
            return responseData;
        }

        return {
            ...responseData,
            usage,
        };
    }

    private buildUsageForEndpoint( endpoint: string, requestBody: any, responseData: any ): Record<string, any> | null {
        const promptTokens = this.calculateTokenCountFromStrings( this.extractRequestTokenStrings( requestBody, endpoint ), 0 );
        const completionTokens = this.calculateTokenCountFromStrings( this.extractResponseTokenStrings( endpoint, responseData ), 0 );

        if ( endpoint === 'responses' ) {
            return {
                input_tokens: promptTokens,
                input_tokens_details: {
                    cached_tokens: 0,
                },
                output_tokens: completionTokens,
                output_tokens_details: {
                    reasoning_tokens: 0,
                },
                total_tokens: promptTokens + completionTokens,
            };
        }

        if ( endpoint === 'embeddings' ) {
            const embeddingTokens = this.calculateEmbeddingTokenCount( requestBody?.input );
            return {
                prompt_tokens: embeddingTokens || promptTokens,
                total_tokens: embeddingTokens || promptTokens,
            };
        }

        if ( endpoint === 'chat/completions' || endpoint === 'completions' ) {
            return {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
            };
        }

        // Images endpoints use token usage from the response if available
        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return null;
        }

        return null;
    }

    private extractRequestTokenStrings( body: any, endpoint?: string ): string[] {
        if ( !body ) {
            return [];
        }

        if ( endpoint === 'completions' ) {
            return this.collectTokenStrings( body.prompt );
        }

        if ( endpoint === 'chat/completions' ) {
            return this.collectTokenStrings( body.messages );
        }

        if ( endpoint === 'responses' ) {
            return [
                ...this.collectTokenStrings( body.input ),
                ...this.collectTokenStrings( body.instructions ),
                ...this.collectTokenStrings( body.prompt ),
            ];
        }

        if ( endpoint === 'embeddings' ) {
            return this.collectTokenStrings( body.input );
        }

        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return this.collectTokenStrings( body.prompt );
        }

        return this.collectTokenStrings( body );
    }

    private extractResponseTokenStrings( endpoint: string, responseData: any ): string[] {
        if ( !responseData || typeof responseData !== 'object' ) {
            return [];
        }

        if ( endpoint === 'completions' || endpoint === 'chat/completions' ) {
            return this.collectTokenStrings( responseData.choices );
        }

        if ( endpoint === 'responses' ) {
            return this.collectTokenStrings( responseData.output );
        }

        if ( endpoint === 'embeddings' ) {
            return [];
        }

        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return [];
        }

        return this.collectTokenStrings( responseData );
    }

    private collectTokenStrings( value: any ): string[] {
        if ( value == null ) {
            return [];
        }

        if ( typeof value === 'string' ) {
            return [value];
        }

        if ( typeof value === 'number' || typeof value === 'boolean' ) {
            return [];
        }

        if ( Array.isArray( value ) ) {
            return value.flatMap( item => this.collectTokenStrings( item ) );
        }

        if ( typeof value !== 'object' ) {
            return [];
        }

        const countableKeys = new Set( [
            'content',
            'text',
            'input',
            'prompt',
            'instructions',
            'messages',
            'message',
            'choices',
            'output',
            'tool_calls',
            'function_call',
            'arguments',
            'code',
            'logs',
            'refusal',
            'query',
            'queries',
            'variables',
            'delta',
            'file_data',
            'file_url',
            'image_url',
        ] );

        const ignoredKeys = new Set( [
            'annotations',
            'metadata',
            'usage',
            'error',
            'id',
            'role',
            'status',
            'type',
            'object',
            'model',
            'created',
            'created_at',
            'finish_reason',
            'index',
            'system_fingerprint',
            'incomplete_details',
            'reason',
        ] );

        return Object.entries( value ).flatMap( ( [key, nestedValue] ) => {
            if ( ignoredKeys.has( key ) ) {
                return [];
            }

            if ( countableKeys.has( key ) ) {
                return this.collectTokenStrings( nestedValue );
            }

            return [];
        } );
    }

    private calculateTokenCountFromStrings( values: string[], fallback: number = 100 ): number {
        const total = values.reduce( ( sum: number, value: string ) =>
            sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0
        );

        return total || fallback;
    }

    private calculateEmbeddingTokenCount( input: any ): number {
        if ( input == null ) {
            return 0;
        }

        if ( typeof input === 'string' ) {
            return Math.max( 1, Math.ceil( input.length / 4 ) );
        }

        if ( typeof input === 'number' ) {
            return 1;
        }

        if ( Array.isArray( input ) ) {
            if ( input.length === 0 ) {
                return 0;
            }

            if ( input.every( item => typeof item === 'number' ) ) {
                return input.length;
            }

            return input.reduce( ( sum: number, item: any ) => sum + this.calculateEmbeddingTokenCount( item ), 0 );
        }

        if ( typeof input === 'object' ) {
            return this.collectTokenStrings( input ).reduce( ( sum: number, value: string ) =>
                sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0
            );
        }

        return 0;
    }
}

export const openAIProxy = new OpenAIProxy();
