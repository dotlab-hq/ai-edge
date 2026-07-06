/**
 * Singleton S3 client wrapper.
 * Uses @aws-sdk/client-s3 for S3-compatible object storage.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';

let s3Client: S3Client | null = null;
let s3Config: {
  bucket: string;
  endpoint: string;
  pathStyle: boolean;
} | null = null;

export interface S3ConfigInput {
  endpoint: string;
  region?: string;
  access_key: string;
  secret_key: string;
  bucket: string;
  path_style: boolean;
}

export function initS3( config: S3ConfigInput ): void {
  if ( s3Client ) return;

  s3Client = new S3Client( {
    endpoint: config.endpoint,
    region: config.region ?? 'auto',
    credentials: {
      accessKeyId: config.access_key,
      secretAccessKey: config.secret_key,
    },
    forcePathStyle: config.path_style,
  } );
  s3Config = {
    bucket: config.bucket,
    endpoint: config.endpoint,
    pathStyle: config.path_style,
  };
  console.info( `[s3] initialized endpoint=${config.endpoint} bucket=${config.bucket} pathStyle=${config.path_style}` );
}

export function getS3Client(): S3Client {
  if ( !s3Client ) {
    throw new Error( 'S3 client not initialized. Call initS3() first.' );
  }
  return s3Client;
}

export function getS3Bucket(): string {
  if ( !s3Config ) {
    throw new Error( 'S3 not initialized. Call initS3() first.' );
  }
  return s3Config.bucket;
}

// ─── S3 Operations ───────────────────────────────────────

export async function s3PutObject( key: string, body: Buffer, contentType?: string ): Promise<void> {
  const params: PutObjectCommandInput = {
    Bucket: getS3Bucket(),
    Key: key,
    Body: body,
    ContentType: contentType ?? 'application/octet-stream',
  };
  await getS3Client().send( new PutObjectCommand( params ) );
}

export async function s3GetObject( key: string ): Promise<{ body: Buffer; contentType: string; contentLength: number }> {
  const response = await getS3Client().send(
    new GetObjectCommand( {
      Bucket: getS3Bucket(),
      Key: key,
    } )
  );

  const chunks: Uint8Array[] = [];
  const stream = response.Body;
  if ( stream ) {
    // Handle both Readable and ReadableStream
    if ( 'transformToByteArray' in stream ) {
      const bytes = await ( stream as any ).transformToByteArray();
      return {
        body: Buffer.from( bytes ),
        contentType: response.ContentType ?? 'application/octet-stream',
        contentLength: response.ContentLength ?? bytes.byteLength,
      };
    }
    // Fallback for Node.js Readable
    const reader = ( stream as any ).getReader?.();
    if ( reader ) {
      while ( true ) {
        const { done, value } = await reader.read();
        if ( done ) break;
        chunks.push( value );
      }
    }
  }

  const combined = Buffer.concat( chunks.map( c => Buffer.from( c ) ) );
  return {
    body: combined,
    contentType: response.ContentType ?? 'application/octet-stream',
    contentLength: response.ContentLength ?? combined.byteLength,
  };
}

export async function s3DeleteObject( key: string ): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand( {
      Bucket: getS3Bucket(),
      Key: key,
    } )
  );
}

export async function s3HeadObject( key: string ): Promise<{ exists: boolean; contentLength: number; contentType: string }> {
  try {
    const response = await getS3Client().send(
      new HeadObjectCommand( {
        Bucket: getS3Bucket(),
        Key: key,
      } )
    );
    return {
      exists: true,
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType ?? 'application/octet-stream',
    };
  } catch ( error: any ) {
    if ( error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404 ) {
      return { exists: false, contentLength: 0, contentType: '' };
    }
    throw error;
  }
}
