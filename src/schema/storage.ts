import { z } from '@hono/zod-openapi'

export const StateAdapterObjectSchema = z.object( {
  redis_url: z.url( 'redis_url must be a valid URL' ).describe( 'Redis connection URL' ),
} )

export const StateAdapterSchema = z.union( [
  z.enum( ['redis', 'memory'] ),
  StateAdapterObjectSchema,
] )

export const VectorStoreSchema = z.object( {
  url: z.url( 'vectorStore.url must be a valid URL' ).describe( 'Base URL of the vector store API to proxy requests to' ),
  apiKey: z.string( { error: 'vectorStore.apiKey is required' } ).min( 1, 'vectorStore.apiKey cannot be empty' ).describe( 'API key sent as Authorization header to the vector store' ),
} ).strict().optional().describe( 'Vector store proxy configuration — forwards /v1/vector_stores and /v1/files requests to the target. Check out https://github.com/dotlab-hq/vector-store! :)' )

export const RealtimeSchema = z.object( {
  url: z.url( 'realtime.url must be a valid URL' ).describe( 'Base URL of the OpenAI Realtime API to proxy requests to (e.g. https://api.openai.com/v1)' ),
  apiKey: z.string( { error: 'realtime.apiKey is required' } ).min( 1, 'realtime.apiKey cannot be empty' ).describe( 'API key sent as Authorization header to the Realtime API' ),
} ).strict().optional().describe( 'Realtime API proxy configuration — forwards /v1/realtime requests to the target endpoint' )

const StorageS3Schema = z.object( {
  endpoint: z.string().min( 1 ).describe( 'S3-compatible endpoint URL (e.g. https://s3.amazonaws.com or http://minio:9000)' ),
  region: z.string().default( 'auto' ).describe( 'AWS region for S3 (default auto for S3-compatible services like MinIO)' ),
  access_key: z.string().min( 1 ).describe( 'S3 access key ID' ),
  secret_key: z.string().min( 1 ).describe( 'S3 secret access key' ),
  bucket: z.string().min( 1 ).describe( 'S3 bucket name for skill and file storage' ),
  path_style: z.boolean().default( false ).describe( 'Use path-style S3 URLs (true for MinIO, false for AWS)' ),
} )

export const StorageSchema = z.object( {
  mongo_uri: z.string().min( 1 ).describe( 'MongoDB connection URI for skills, skill versions, and file metadata (e.g. mongodb://localhost:27017)' ),
  s3: StorageS3Schema,
} ).optional().describe( 'Storage backend for skills and files — requires MongoDB for metadata and S3-compatible object storage for content' )
