/**
 * FileStore — MongoDB-backed file metadata storage with S3 content.
 *
 * Supports both OpenAI and Anthropic file upload/download formats.
 * Files are uploaded to S3 and metadata is stored in MongoDB.
 */
import { type Collection, type Db, type Filter, type Sort } from 'mongodb';
import { getMongoDb } from './MongoConnection';
import {
  s3PutObject,
  s3GetObject,
  s3DeleteObject,
  type S3ConfigInput,
} from './S3Client';
import { initS3 } from './S3Client';
import {
  type FileRecord,
  type AnthropicPageResponse,
  generateFileId,
  encodePageToken,
  decodePageToken,
} from './types';

const FILES_COLLECTION = 'files';

// ─── Singleton ───────────────────────────────────────────

let _fileStore: FileStore | null = null;

export class FileStore {
  private dbPromise: Promise<Db> | null = null;
  private mongoUri?: string;
  private s3Inited = false;

  constructor( mongoUri?: string ) {
    this.mongoUri = mongoUri;
  }

  /** Lazily connect to MongoDB on first use. */
  private async getDb(): Promise<Db> {
    if ( !this.dbPromise ) {
      this.dbPromise = getMongoDb( this.mongoUri );
    }
    return this.dbPromise;
  }

  private async files(): Promise<Collection<FileRecord>> {
    const db = await this.getDb();
    const col = db.collection<FileRecord>( FILES_COLLECTION );
    await col.createIndex( { id: 1 }, { unique: true } );
    await col.createIndex( { purpose: 1 } );
    await col.createIndex( { scope_id: 1 } );
    await col.createIndex( { created_at: -1 } );
    return col;
  }

  // ─── File CRUD ───────────────────────────────────────

  /**
   * Upload a new file: store content in S3 and metadata in MongoDB.
   */
  async uploadFile( params: {
    filename: string;
    mimeType?: string;
    purpose: string;
    content: Buffer;
    scope_id?: string;
    /** Whether this file is resolvable in inference by SkillResolver. Default false. */
    downloadable?: boolean;
  } ): Promise<FileRecord> {
    const col = await this.files();
    const id = generateFileId();
    const now = Math.floor( Date.now() / 1000 );
    const s3Key = `files/${id}/${params.filename}`;

    // Upload content to S3
    await s3PutObject( s3Key, params.content, params.mimeType ?? 'application/octet-stream' );

    const record: FileRecord = {
      id,
      filename: params.filename,
      mime_type: params.mimeType ?? 'application/octet-stream',
      size_bytes: params.content.length,
      purpose: params.purpose,
      created_at: now,
      object: 'file',
      status: 'processed',
      _s3Key: s3Key,
      scope_id: params.scope_id,
      downloadable: params.downloadable ?? false,
    };

    await col.insertOne( record );
    return record;
  }

  /**
   * Get file metadata by ID.
   */
  async getFile( fileId: string ): Promise<FileRecord | null> {
    const col = await this.files();
    console.log( `[FileStore] getFile(${fileId}) querying collection...` );
    const doc = await col.findOne( { id: fileId } );
    console.log( `[FileStore] getFile(${fileId}) result: ${doc ? `found (mime=${doc.mime_type}, _s3Key=${doc._s3Key}, downloadable=${doc.downloadable})` : 'NOT FOUND'}` );
    return doc;
  }

  /**
   * List files with pagination.
   * Supports both OpenAI format (purpose filter) and Anthropic format (scope_id, after_id, before_id).
   */
  async listFiles( options: {
    limit?: number;
    after_id?: string;
    before_id?: string;
    purpose?: string;
    scope_id?: string;
    page_token?: string;
  } = {} ): Promise<{
    data: FileRecord[];
    has_more: boolean;
    next_page?: string;
  }> {
    const col = await this.files();
    const limit = Math.min( Math.max( options.limit ?? 20, 1 ), 10000 );

    const filter: Filter<FileRecord> = {};
    if ( options.purpose ) {
      filter.purpose = options.purpose;
    }
    if ( options.scope_id ) {
      filter.scope_id = options.scope_id;
    }

    // Anthropic-style cursor pagination (after_id / before_id)
    if ( options.after_id ) {
      const afterDoc = await col.findOne( { id: options.after_id } );
      if ( afterDoc ) {
        filter.created_at = { $lt: afterDoc.created_at } as any;
      }
    } else if ( options.before_id ) {
      const beforeDoc = await col.findOne( { id: options.before_id } );
      if ( beforeDoc ) {
        filter.created_at = { $gt: beforeDoc.created_at } as any;
      }
    } else if ( options.page_token ) {
      const cursor = decodePageToken( options.page_token );
      filter.created_at = { $lt: Number( cursor ) } as any;
    }

    const sort: Sort = { created_at: -1 as const };

    const results = await col
      .find( filter )
      .sort( sort )
      .limit( limit + 1 )
      .toArray();

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice( 0, limit ) : results;

    return {
      data,
      has_more: hasMore,
      next_page: hasMore
        ? encodePageToken( String( data[data.length - 1]!.created_at ) )
        : undefined,
    };
  }

  /**
   * Download file content from S3.
   */
  async getFileContent( fileId: string ): Promise<{ body: Buffer; filename: string; contentType: string; sizeBytes: number } | null> {
    const record = await this.getFile( fileId );
    if ( !record ) {
      console.error( `[FileStore] getFileContent(${fileId}): no record found` );
      return null;
    }
    if ( !record._s3Key ) {
      console.error( `[FileStore] getFileContent(${fileId}): record found but _s3Key is missing` );
      return null;
    }
    console.log( `[FileStore] getFileContent(${fileId}): fetching S3 object key=${record._s3Key}` );

    try {
      const { body, contentType, contentLength } = await s3GetObject( record._s3Key );
      console.log( `[FileStore] getFileContent(${fileId}): S3 fetch OK (${contentType}, ${contentLength} bytes)` );
      return {
        body,
        filename: record.filename,
        contentType,
        sizeBytes: contentLength,
      };
    } catch ( err: any ) {
      console.error( `[FileStore] getFileContent(${fileId}): S3 fetch FAILED:`, err?.message || String( err ) );
      return null;
    }
  }

  /**
   * Delete a file and its S3 content.
   */
  async deleteFile( fileId: string ): Promise<boolean> {
    const col = await this.files();
    const record = await col.findOne( { id: fileId } );
    if ( !record ) return false;

    if ( record._s3Key ) {
      await s3DeleteObject( record._s3Key ).catch( () => {} );
    }

    const result = await col.deleteOne( { _id: record._id } );
    return result.deletedCount > 0;
  }

  /**
   * Ensure S3 is initialized from storage config.
   */
  ensureS3( s3Config: S3ConfigInput ): void {
    if ( this.s3Inited ) return;
    initS3( s3Config );
    this.s3Inited = true;
  }
}

// ─── Singleton factory ───────────────────────────────────

export function getFileStore( mongoUri?: string ): FileStore {
  if ( !_fileStore ) {
    _fileStore = new FileStore( mongoUri );
  }
  return _fileStore;
}
