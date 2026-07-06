/**
 * SkillStore — MongoDB-backed skill & skill-version storage with S3 content.
 *
 * Handles both Anthropic and OpenAI skill formats transparently.
 * All data is stored in MongoDB collections and binary content (zip archives)
 * is stored in S3.
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
  type SkillRecord,
  type SkillVersionRecord,
  type AnthropicPageResponse,
  generateSkillId,
  generateSkillVersionId,
  generateFileVersion,
  encodePageToken,
  decodePageToken,
} from './types';

const SKILLS_COLLECTION = 'skills';
const SKILL_VERSIONS_COLLECTION = 'skill_versions';

// ─── Singleton ───────────────────────────────────────────

let _skillStore: SkillStore | null = null;

export class SkillStore {
  private dbPromise: Promise<Db>;
  private mongoUri?: string;
  private s3Inited = false;

  constructor( mongoUri?: string ) {
    this.mongoUri = mongoUri;
    this.dbPromise = getMongoDb( mongoUri );
  }

  private async skills(): Promise<Collection<SkillRecord>> {
    const db = await this.dbPromise;
    const col = db.collection<SkillRecord>( SKILLS_COLLECTION );
    await col.createIndex( { id: 1 }, { unique: true } );
    await col.createIndex( { display_title: 1 } );
    await col.createIndex( { source: 1 } );
    return col;
  }

  private async versions(): Promise<Collection<SkillVersionRecord>> {
    const db = await this.dbPromise;
    const col = db.collection<SkillVersionRecord>( SKILL_VERSIONS_COLLECTION );
    await col.createIndex( { id: 1 }, { unique: true } );
    await col.createIndex( { skill_id: 1 } );
    await col.createIndex( { skill_id: 1, version: 1 }, { unique: true } );
    return col;
  }

  // ─── Skills CRUD ─────────────────────────────────────

  /**
   * Create a new skill.
   */
  async createSkill( params: {
    name: string;
    description?: string;
    display_title?: string;
    source?: string;
    default_version?: string;
  } ): Promise<SkillRecord> {
    const col = await this.skills();
    const now = new Date().toISOString();
    const id = generateSkillId();

    const record: SkillRecord = {
      id,
      created_at: now,
      display_title: params.display_title ?? params.name,
      name: params.name,
      description: params.description ?? '',
      latest_version: '',
      source: params.source ?? 'custom',
      default_version: params.default_version ?? '',
      _formats: ['anthropic', 'openai'],
    };

    await col.insertOne( record );
    return record;
  }

  /**
   * Get a single skill by ID.
   */
  async getSkill( skillId: string ): Promise<SkillRecord | null> {
    const col = await this.skills();
    return col.findOne( { id: skillId } );
  }

  /**
   * List skills with pagination (Anthropic format).
   */
  async listSkills( options: {
    limit?: number;
    page?: string;
    source?: string;
  } = {} ): Promise<AnthropicPageResponse<SkillRecord>> {
    const col = await this.skills();
    const limit = Math.min( Math.max( options.limit ?? 20, 1 ), 1000 );

    const filter: Filter<SkillRecord> = {};
    if ( options.source ) {
      filter.source = options.source;
    }

    const sort: Sort = { created_at: -1 as const };

    if ( options.page ) {
      const cursor = decodePageToken( options.page );
      filter.created_at = { $lt: cursor } as any;
    }

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
        ? encodePageToken( data[data.length - 1]!.created_at )
        : undefined,
    };
  }

  /**
   * Delete a skill and all its versions.
   */
  async deleteSkill( skillId: string ): Promise<boolean> {
    const skillsCol = await this.skills();
    const versionsCol = await this.versions();

    // Delete all versions (and their S3 content)
    const versions = await versionsCol.find( { skill_id: skillId } ).toArray();
    for ( const ver of versions ) {
      if ( ver._s3Key ) {
        await s3DeleteObject( ver._s3Key ).catch( () => {} );
      }
    }
    await versionsCol.deleteMany( { skill_id: skillId } );

    const result = await skillsCol.deleteOne( { id: skillId } );
    return result.deletedCount > 0;
  }

  // ─── Skill Versions CRUD ────────────────────────────

  /**
   * Create a new skill version.
   */
  async createSkillVersion( params: {
    skill_id: string;
    name?: string;
    description?: string;
    directory?: string;
    content?: Buffer;
    contentSize?: number;
  } ): Promise<SkillVersionRecord> {
    const versionsCol = await this.versions();
    const skillsCol = await this.skills();
    const version = generateFileVersion();
    const id = generateSkillVersionId();
    const now = new Date().toISOString();

    // Upload content to S3
    let s3Key = '';
    let contentSize = params.contentSize ?? 0;
    if ( params.content && params.content.length > 0 ) {
      s3Key = `skills/${params.skill_id}/versions/${version}/content`;
      contentSize = params.content.length;
      await s3PutObject( s3Key, params.content, 'application/zip' );
    }

    const record: SkillVersionRecord = {
      id,
      version,
      created_at: now,
      description: params.description ?? '',
      directory: params.directory ?? '',
      name: params.name ?? '',
      skill_id: params.skill_id,
      type: 'skill_version',
      _s3Key: s3Key,
      _contentSize: contentSize,
    };

    await versionsCol.insertOne( record );

    // Update parent skill's latest_version
    await skillsCol.updateOne(
      { id: params.skill_id },
      {
        $set: {
          latest_version: version,
          description: record.description || undefined,
          name: record.name || undefined,
        },
      }
    );

    return record;
  }

  /**
   * Get a specific skill version.
   */
  async getSkillVersion( skillId: string, version: string ): Promise<SkillVersionRecord | null> {
    const col = await this.versions();
    return col.findOne( { skill_id: skillId, version } );
  }

  /**
   * List skill versions with pagination.
   */
  async listSkillVersions( skillId: string, options: {
    limit?: number;
    page?: string;
  } = {} ): Promise<AnthropicPageResponse<SkillVersionRecord>> {
    const col = await this.versions();
    const limit = Math.min( Math.max( options.limit ?? 20, 1 ), 1000 );

    const filter: Filter<SkillVersionRecord> = { skill_id: skillId };

    if ( options.page ) {
      const cursor = decodePageToken( options.page );
      filter.version = { $lt: cursor } as any;
    }

    const results = await col
      .find( filter )
      .sort( { version: -1 as const } )
      .limit( limit + 1 )
      .toArray();

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice( 0, limit ) : results;

    return {
      data,
      has_more: hasMore,
      next_page: hasMore
        ? encodePageToken( data[data.length - 1]!.version )
        : undefined,
    };
  }

  /**
   * Delete a skill version and its S3 content.
   */
  async deleteSkillVersion( skillId: string, version: string ): Promise<boolean> {
    const col = await this.versions();
    const record = await col.findOne( { skill_id: skillId, version } );
    if ( !record ) return false;

    if ( record._s3Key ) {
      await s3DeleteObject( record._s3Key ).catch( () => {} );
    }

    const result = await col.deleteOne( { _id: record._id } );
    return result.deletedCount > 0;
  }

  /**
   * Download skill version content from S3.
   */
  async getSkillVersionContent( skillId: string, version: string ): Promise<Buffer | null> {
    const record = await this.getSkillVersion( skillId, version );
    if ( !record || !record._s3Key ) return null;

    try {
      const { body } = await s3GetObject( record._s3Key );
      return body;
    } catch {
      return null;
    }
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

export function getSkillStore( mongoUri?: string ): SkillStore {
  if ( !_skillStore ) {
    _skillStore = new SkillStore( mongoUri );
  }
  return _skillStore;
}
