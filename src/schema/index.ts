import { z } from '@hono/zod-openapi'

const RateLimitSchema = z.object( {
  // If any of these fields are omitted the system will treat that dimension as "unlimited".
  tokensPerMinute: z.number( { error: 'tokensPerMinute must be a number' } ).int( 'tokensPerMinute must be an integer' ).positive( 'tokensPerMinute must be > 0' ).optional(),
  requestsPerMinute: z.number( { error: 'requestsPerMinute must be a number' } ).int( 'requestsPerMinute must be an integer' ).positive( 'requestsPerMinute must be > 0' ).optional(),
  requestsPerDay: z.number( { error: 'requestsPerDay must be a number' } ).int( 'requestsPerDay must be an integer' ).positive( 'requestsPerDay must be > 0' ).optional(),
} ).optional()

const ImageModelsSchema = z.union( [
  z.boolean( { error: 'imageModels must be a boolean' } ),
  z.object( {
    image_generation: z.boolean( { error: 'image_generation must be a boolean' } ).optional(),
    image_editing: z.boolean( { error: 'image_editing must be a boolean' } ).optional(),
  } ).strict(),
] ).optional().describe( 'If true, all models provided by this provider are for image operations only. Use { image_generation, image_editing } to control per-endpoint routing.' )

const EmbeddingsSchema = z.boolean( { error: 'embeddings must be a boolean' } ).default( false ).describe( 'If true, this provider supports embeddings endpoint' )

const OpenAIModelSchema = z.object( {
  id: z.string( { error: 'id is required' } ).min( 1, 'id cannot be empty' ),
  name: z.string( { error: 'name is required' } ).min( 1, 'name cannot be empty' ),
  models: z.array( z.string( { error: 'each model must be a string' } ) ).min( 1, 'models array must contain at least one model' ),
  imageModels: ImageModelsSchema,
  embeddings: EmbeddingsSchema,
  individualLimit: z.boolean( { error: 'individualLimit must be a boolean' } ).default( false ),
  baseUrl: z.url( 'baseUrl must be a valid URL' ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: RateLimitSchema,
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( false ).describe( 'If true, when this provider is selected it may route to any model the provider advertises at random' ),
} )

const AnthropicModelSchema = z.object( {
  id: z.string( { error: 'id is required' } ).min( 1, 'id cannot be empty' ),
  name: z.string( { error: 'name is required' } ).min( 1, 'name cannot be empty' ),
  models: z.array( z.string( { error: 'each model must be a string' } ) ).min( 1, 'models array must contain at least one model' ),
  individualLimit: z.boolean( { error: 'individualLimit must be a boolean' } ).default( false ),
  baseUrl: z.url( 'baseUrl must be a valid URL' ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: RateLimitSchema,
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( false ).describe( 'If true, when this provider is selected it may route to any model the provider advertises at random' ),
} )

const StateAdapterObjectSchema = z.object( {
  redis_url: z.url( 'redis_url must be a valid URL' ).describe( 'Redis connection URL' ),
} )

const StateAdapterSchema = z.union( [
  z.enum( ['redis', 'memory'] ),
  StateAdapterObjectSchema,
] )

export const ConfigSchema = z.object( {
  proxy: z.url( 'Proxy URL must be a valid URL' ).optional().describe( 'URL of the proxy server to forward requests to' ),
  '$schema': z.url( 'Not a valid $schema URL' ).describe( 'URL to the JSON Schema that this configuration adheres to' ),
  'state-adapter': StateAdapterSchema.describe( 'Storage backend for state management - redis, memory, or { redis_url: string }' ),
  rateLimit: RateLimitSchema.describe( 'Global rate limit applied to all models unless individualLimit is true' ),
  models: z.object( {
    openai: z.array( OpenAIModelSchema ).min( 1, 'At least one OpenAI config is required' ).optional().describe( 'OpenAI provider configurations. If omitted, no OpenAI models will be available' ),
    anthropic: z.array( AnthropicModelSchema ).min( 1, 'At least one Anthropic config is required' ).optional().describe( 'Anthropic provider configurations. If omitted, no Anthropic models will be available' ),
  } ),
} )

export type StateAdapter = z.infer<typeof StateAdapterSchema>
export type Config = z.infer<typeof ConfigSchema>
export { ConfigSchema as schema }
