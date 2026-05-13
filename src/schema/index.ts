import { z } from '@hono/zod-openapi'

const RateLimitSpec = z.object( {
  // If any of these fields are omitted the system will treat that dimension as "unlimited".
  tokensPerMinute: z.number( { error: 'tokensPerMinute must be a number' } ).int( 'tokensPerMinute must be an integer' ).positive( 'tokensPerMinute must be > 0' ).optional(),
  requestsPerMinute: z.number( { error: 'requestsPerMinute must be a number' } ).int( 'requestsPerMinute must be an integer' ).positive( 'requestsPerMinute must be > 0' ).optional(),
  requestsPerDay: z.number( { error: 'requestsPerDay must be a number' } ).int( 'requestsPerDay must be an integer' ).positive( 'requestsPerDay must be > 0' ).optional(),
} ).strict()

const RateLimitSchema = RateLimitSpec.optional()

const ImageModelsSchema = z.union( [
  z.boolean( { error: 'imageModels must be a boolean' } ),
  z.object( {
    image_generation: z.boolean( { error: 'image_generation must be a boolean' } ).optional(),
    image_editing: z.boolean( { error: 'image_editing must be a boolean' } ).optional(),
  } ).strict(),
] ).optional().describe( 'If true, all models provided by this provider are for image operations only. Use { image_generation, image_editing } to control per-endpoint routing.' )

const EmbeddingsSchema = z.boolean( { error: 'embeddings must be a boolean' } ).default( false ).describe( 'If true, this provider supports embeddings endpoint' )

const ModelWithRateLimitSchema = z.object( {
  model: z.string( { error: 'model is required' } ).min( 1, 'model cannot be empty' ),
  rateLimit: RateLimitSpec,
} ).strict()

const OpenAIModelSchema = z.object( {
  id: z.string( { error: 'id is required' } ).min( 1, 'id cannot be empty' ),
  name: z.string( { error: 'name is required' } ).min( 1, 'name cannot be empty' ),
  models: z.array( z.union( [z.string( { error: 'each model must be a string' } ), ModelWithRateLimitSchema] ) ).min( 1, 'models array must contain at least one model' ),
  imageModels: ImageModelsSchema,
  embeddings: EmbeddingsSchema,
  individualLimit: z.boolean( { error: 'individualLimit must be a boolean' } ).default( false ),
  baseUrl: z.url( 'baseUrl must be a valid URL' ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: RateLimitSchema,
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( false ).describe( 'If true, when this provider is selected it may route to any model the provider advertises at random' ),
} )

  .superRefine( ( val, ctx ) => {
    const models = val.models || []
    const hasObject = models.some( m => typeof m === 'object' )
    const hasString = models.some( m => typeof m === 'string' )
    if ( hasObject && hasString ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'models must be all strings or all objects with { model, rateLimit }' } )
    }
    if ( hasObject ) {
      if ( val.rateLimit ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'backend-level rateLimit is forbidden when using per-model rate limits' } )
      }
      if ( val.individualLimit === false ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'individualLimit cannot be false when using per-model rate limits' } )
      }
    }
  } )

const AnthropicModelSchema = z.object( {
  id: z.string( { error: 'id is required' } ).min( 1, 'id cannot be empty' ),
  name: z.string( { error: 'name is required' } ).min( 1, 'name cannot be empty' ),
  models: z.array( z.union( [z.string( { error: 'each model must be a string' } ), ModelWithRateLimitSchema] ) ).min( 1, 'models array must contain at least one model' ),
  individualLimit: z.boolean( { error: 'individualLimit must be a boolean' } ).default( false ),
  baseUrl: z.url( 'baseUrl must be a valid URL' ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: RateLimitSchema,
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( false ).describe( 'If true, when this provider is selected it may route to any model the provider advertises at random' ),
} )

  .superRefine( ( val, ctx ) => {
    const models = val.models || []
    const hasObject = models.some( m => typeof m === 'object' )
    const hasString = models.some( m => typeof m === 'string' )
    if ( hasObject && hasString ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'models must be all strings or all objects with { model, rateLimit }' } )
    }
    if ( hasObject ) {
      if ( val.rateLimit ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'backend-level rateLimit is forbidden when using per-model rate limits' } )
      }
      if ( val.individualLimit === false ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'individualLimit cannot be false when using per-model rate limits' } )
      }
    }
  } )

const StateAdapterObjectSchema = z.object( {
  redis_url: z.url( 'redis_url must be a valid URL' ).describe( 'Redis connection URL' ),
} )

const StateAdapterSchema = z.union( [
  z.enum( ['redis', 'memory'] ),
  StateAdapterObjectSchema,
] )

const WebSearchRateLimitSchema = z.object( {
  requestsPerMinute: z.number( { error: 'requestsPerMinute must be a number' } ).int( 'requestsPerMinute must be an integer' ).positive( 'requestsPerMinute must be > 0' ).optional(),
  requestsPerDay: z.number( { error: 'requestsPerDay must be a number' } ).int( 'requestsPerDay must be an integer' ).positive( 'requestsPerDay must be > 0' ).optional(),
  requestsPerMonth: z.number( { error: 'requestsPerMonth must be a number' } ).int( 'requestsPerMonth must be an integer' ).positive( 'requestsPerMonth must be > 0' ).optional(),
} ).optional()

const WebSearchToolSchema = z.object( {
  type: z.enum( ['tavily', 'exa'] ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: WebSearchRateLimitSchema,
} )

const WebSearchSchema = z.object( {
  tools: z.array( WebSearchToolSchema ).min( 1, 'tools.webSearch.tools must contain at least one provider' ),
} ).optional()

const CodeInterpreterResourcesSchema = z.object( {
  cpu: z.number( { error: 'cpu must be a number' } ).int( 'cpu must be an integer' ).positive( 'cpu must be > 0' ).optional(),
  memory: z.number( { error: 'memory must be a number' } ).int( 'memory must be an integer' ).positive( 'memory must be > 0' ).optional(),
  disk: z.number( { error: 'disk must be a number' } ).int( 'disk must be an integer' ).positive( 'disk must be > 0' ).optional(),
} ).strict().optional()

const CodeInterpreterSchema = z.object( {
  type: z.enum( ['daytona'] ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  apiUrl: z.url( 'apiUrl must be a valid URL' ).optional(),
  language: z.enum( ['python', 'typescript', 'javascript'] ).optional(),
  timeout: z.number( { error: 'timeout must be a number' } ).int( 'timeout must be an integer' ).positive( 'timeout must be > 0' ).optional(),
  target: z.enum( ['us', 'eu'] ).optional(),
  image: z.string( { error: 'image must be a string' } ).min( 1, 'image cannot be empty' ).optional(),
  snapshot: z.string( { error: 'snapshot must be a string' } ).min( 1, 'snapshot cannot be empty' ).optional(),
  resources: CodeInterpreterResourcesSchema,
  autoStopInterval: z.number( { error: 'autoStopInterval must be a number' } ).int( 'autoStopInterval must be an integer' ).min( 0, 'autoStopInterval must be >= 0' ).optional(),
  labels: z.record( z.string(), z.string( { error: 'labels values must be strings' } ) ).optional(),
  initialFiles: z.record( z.string(), z.string( { error: 'initialFiles values must be strings' } ) ).optional(),
} ).strict()

const ToolsSchema = z.object( {
  webSearch: WebSearchSchema.describe( 'Optional built-in web search providers used to satisfy OpenAI and Anthropic web search tool requests' ),
  code_interpreter: CodeInterpreterSchema.optional().describe( 'Alias for codeInterpreter (optional code interpreter provider)' ),
} ).optional()

export const ConfigSchema = z.object( {
  proxy: z.url( 'Proxy URL must be a valid URL' ).optional().describe( 'URL of the proxy server to forward requests to' ),
  '$schema': z.url( 'Not a valid $schema URL' ).describe( 'URL to the JSON Schema that this configuration adheres to' ),
  'state-adapter': StateAdapterSchema.describe( 'Storage backend for state management - redis, memory, or { redis_url: string }' ),
  rateLimit: RateLimitSchema.describe( 'Global rate limit applied to all models unless individualLimit is true' ),
  tools: ToolsSchema.describe( 'Optional built-in proxy tools such as web search' ),
  models: z.object( {
    openai: z.array( OpenAIModelSchema ).min( 1, 'At least one OpenAI config is required' ).optional().describe( 'OpenAI provider configurations. If omitted, no OpenAI models will be available' ),
    anthropic: z.array( AnthropicModelSchema ).min( 1, 'At least one Anthropic config is required' ).optional().describe( 'Anthropic provider configurations. If omitted, no Anthropic models will be available' ),
  } ),
} )

export type StateAdapter = z.infer<typeof StateAdapterSchema>
export type Config = z.infer<typeof ConfigSchema>
export { ConfigSchema as schema }
