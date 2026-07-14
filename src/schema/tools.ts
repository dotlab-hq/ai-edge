import { z } from '@hono/zod-openapi'
import { WebSearchRateLimitSchema } from '@/schema/rateLimit'

const WebSearchDefaultsSchema = z.object( {
  maxResults: z.number( { error: 'maxResults must be a number' } ).int( 'maxResults must be an integer' ).positive( 'maxResults must be > 0' ).optional(),
  expandQueries: z.boolean( { error: 'expandQueries must be a boolean' } ).optional(),
  maxExpandedQueries: z.number( { error: 'maxExpandedQueries must be a number' } ).int( 'maxExpandedQueries must be an integer' ).positive( 'maxExpandedQueries must be > 0' ).optional(),
  parallelQueries: z.number( { error: 'parallelQueries must be a number' } ).int( 'parallelQueries must be an integer' ).positive( 'parallelQueries must be > 0' ).optional(),
  softTimeoutMs: z.number( { error: 'softTimeoutMs must be a number' } ).int( 'softTimeoutMs must be an integer' ).positive( 'softTimeoutMs must be > 0' ).optional(),
  providerTimeoutMs: z.number( { error: 'providerTimeoutMs must be a number' } ).int( 'providerTimeoutMs must be an integer' ).positive( 'providerTimeoutMs must be > 0' ).optional(),
} ).strict().optional()

const WebSearchProviderOptionsSchema = z.object( {
  maxResults: z.number( { error: 'maxResults must be a number' } ).int( 'maxResults must be an integer' ).positive( 'maxResults must be > 0' ).optional(),
  searchDepth: z.enum( ['basic', 'advanced'] ).optional(),
  includeRawContent: z.boolean( { error: 'includeRawContent must be a boolean' } ).optional(),
  includeAnswer: z.boolean( { error: 'includeAnswer must be a boolean' } ).optional(),
} ).strict().optional()

const WebSearchToolSchema = z.object( {
  type: z.enum( ['tavily', 'exa'] ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: WebSearchRateLimitSchema,
  timeoutMs: z.number( { error: 'timeoutMs must be a number' } ).int( 'timeoutMs must be an integer' ).positive( 'timeoutMs must be > 0' ).optional(),
  options: WebSearchProviderOptionsSchema,
} )

export const WebSearchSchema = z.object( {
  tools: z.array( WebSearchToolSchema ).min( 1, 'tools.webSearch.tools must contain at least one provider' ),
  defaults: WebSearchDefaultsSchema,
} ).optional()

const CodeInterpreterResourcesSchema = z.object( {
  cpu: z.number( { error: 'cpu must be a number' } ).int( 'cpu must be an integer' ).positive( 'cpu must be > 0' ).optional(),
  memory: z.number( { error: 'memory must be a number' } ).int( 'memory must be an integer' ).positive( 'memory must be > 0' ).optional(),
  disk: z.number( { error: 'disk must be a number' } ).int( 'disk must be an integer' ).positive( 'disk must be > 0' ).optional(),
} ).strict().optional()

export const CodeInterpreterSchema = z.object( {
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

export const ToolsSchema = z.object( {
  webSearch: WebSearchSchema.describe( 'Optional built-in web search providers used to satisfy OpenAI and Anthropic web search tool requests' ),
  code_interpreter: CodeInterpreterSchema.optional().describe( 'Alias for codeInterpreter (optional code interpreter provider)' ),
} ).optional()
