import { z } from '@hono/zod-openapi'
import { RateLimitSchema } from '@/schema/rateLimit'
import { OpenAIModelSchema, AnthropicModelSchema } from '@/schema/models'
import { ToolsSchema } from '@/schema/tools'
import { StorageSchema, StateAdapterSchema, VectorStoreSchema, RealtimeSchema } from '@/schema/storage'

const SpooferSchema = z.boolean( { error: 'spoofer must be a boolean' } ).optional().default( false ).describe( 'If true, randomly generated IP spoofing headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP, etc.) are added to every upstream request' )

export const ConfigSchema = z.object( {
  proxy: z.url( 'Proxy URL must be a valid URL' ).optional().describe( 'URL of the proxy server to forward requests to' ),
  spoofer: SpooferSchema,
  '$schema': z.url( 'Not a valid $schema URL' ).describe( 'URL to the JSON Schema that this configuration adheres to' ),
  'state-adapter': StateAdapterSchema.describe( 'Storage backend for state management - redis, memory, or { redis_url: string }' ),
  rateLimit: RateLimitSchema.describe( 'Global rate limit applied to all models unless individualLimit is true' ),
  storage: StorageSchema,
  tools: ToolsSchema.describe( 'Optional built-in proxy tools such as web search' ),
  vectorStore: VectorStoreSchema,
  realtime: RealtimeSchema,
  models: z.object( {
    openai: z.array( OpenAIModelSchema ).min( 1, 'At least one OpenAI config is required' ).optional().describe( 'OpenAI provider configurations. If omitted, no OpenAI models will be available' ),
    anthropic: z.array( AnthropicModelSchema ).min( 1, 'At least one Anthropic config is required' ).optional().describe( 'Anthropic provider configurations. If omitted, no Anthropic models will be available' ),
  } ),
} )

export type StateAdapter = z.infer<typeof StateAdapterSchema>
export type Config = z.infer<typeof ConfigSchema>
export { ConfigSchema as schema }
