import { Hono } from 'hono'
import { logger } from 'hono/logger';
import { CACHE } from "./src/state";
import { openAIProxy } from "./src/core/OpenAIProxy";
import { anthropicProxy } from "./src/core/AnthropicProxy";
import { CONFIG } from "./src/utils/schema.lookup";
import { rateLimitManager } from "./src/core/RateLimitManager";
import { getUnifiedModelCatalog, refreshUnifiedModelCatalog } from "./src/utils/modelCatalog";

const app = new Hono()
app.use( logger() )

// Auto-load cache/stats on startup
let cachedStats: Record<string, any> = {};

async function loadStats() {
    try {
        await refreshUnifiedModelCatalog( CONFIG.proxy );
        cachedStats = {};
        const openAIConfigs = CONFIG.models.openai ?? [];

        for ( const config of openAIConfigs ) {
            const providerStats: Record<string, any> = {};

            // Collect stats for all models supported by this provider
            for ( const modelEntry of config.models ) {
                const modelName = typeof modelEntry === 'string' ? modelEntry : ( modelEntry as any ).model
                const usage = await rateLimitManager.getUsage( config.id, modelName );
                if ( usage ) {
                    const tokensLimit = config.rateLimit?.tokensPerMinute ?? config.rateLimit?.requestsPerMinute ?? 0;
                    providerStats[modelName] = {
                        requestsUsed: usage.dailyRequests,
                        dailyRequests: usage.dailyRequests,
                        tokensUsed: Math.ceil( tokensLimit - usage.tokensRemaining ),
                        tokensRemaining: usage.tokensRemaining,
                        limits: config.rateLimit
                    };
                }
            }

            // Only add provider to stats if it has at least one model with usage
            if ( Object.keys( providerStats ).length > 0 ) {
                cachedStats[config.id] = providerStats;
            }
        }
    } catch ( error ) {
        // If stats loading fails, continue with empty stats
        cachedStats = {};
    }
}

// Load stats on initialization
await loadStats();

app.get( '/', async ( c ) => {
    const data = await CACHE.getJson();
    try {
        if ( data?.models?.openai && Array.isArray( data.models.openai ) ) {
            // mask apiKey for each configured provider
            data.models.openai = data.models.openai.map( ( m: any ) => ( {
                ...m,
                apiKey: m.apiKey ? '*****' : m.apiKey
            } ) )
        }
    } catch ( e ) {
        // ignore masking errors and return original data
    }
    return c.json( data )
} )

app.get( '/stats', async ( c ) => {
    await loadStats();
    return c.json( cachedStats )
} )

app.get( '/clear', async ( c ) => {
    const confirm = c.req.query( 'confirm' )
    if ( confirm !== 'yes' ) {
        return c.json( { error: 'Confirmation required. Add ?confirm=yes to proceed.' }, 400 )
    }
    await CACHE.clearCache()
    for ( const config of CONFIG.models.openai ?? [] ) {
        // Reset stats for each model in this provider
        for ( const modelEntry of config.models ) {
            const modelName = typeof modelEntry === 'string' ? modelEntry : ( modelEntry as any ).model
            await rateLimitManager.reset( config.id, modelName );
        }
    }
    cachedStats = {};
    return c.json( { message: 'Cache and stats cleared successfully' } )
} )



// v1 models in OpenAI list format
app.get( '/v1/models', async ( c ) => {
    try {
        const catalog = await getUnifiedModelCatalog( CONFIG.proxy )

        return c.json( { object: 'list', data: catalog.data } )
    } catch ( err ) {
        return c.json( { object: 'list', data: [] } )
    }
} )

app.route( '/', openAIProxy.getApp() )
app.route( '/openai', openAIProxy.getApp() )
app.route( '/anthropic', anthropicProxy.getApp() )

export default app
