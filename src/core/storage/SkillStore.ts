/**
 * SkillStore — MongoDB-backed skill & skill-version storage with S3 content.
 *
 * Handles both Anthropic and OpenAI skill formats transparently.
 * All data is stored in MongoDB collections and binary content (zip archives)
 * is stored in S3.
 */
import { type Collection, type Db } from 'mongodb';
import { getMongoDb } from './MongoConnection';
import { type S3ConfigInput, initS3 } from './S3Client';
import {
  type SkillRecord,
  type SkillVersionRecord,
  type AnthropicPageResponse,
} from './types';
import {
  getSkillById,
  listSkillRecords,
  getSkillVersionRecord,
  listSkillVersionRecords,
  getVersionContent,
} from './skillStoreRead';
import {
  createSkillRecord,
  deleteSkillRecord,
  createSkillVersionRecord,
  deleteSkillVersionRecord,
} from './skillStoreWrite';

const SKILLS_COLLECTION = 'skills';
const SKILL_VERSIONS_COLLECTION = 'skill_versions';

// ─── Singleton ───────────────────────────────────────────

let _skillStore: SkillStore | null = null;

export class SkillStore {
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

  private async skills(): Promise<Collection<SkillRecord>> {
    const db = await this.getDb();
    const col = db.collection<SkillRecord>( SKILLS_COLLECTION );
    await col.createIndex( { id: 1 }, { unique: true } );
    await col.createIndex( { display_title: 1 } );
    await col.createIndex( { source: 1 } );
    return col;
  }

  private async versions(): Promise<Collection<SkillVersionRecord>> {
    const db = await this.getDb();
    const col = db.collection<SkillVersionRecord>( SKILL_VERSIONS_COLLECTION );
    await col.createIndex( { id: 1 }, { unique: true } );
    await col.createIndex( { skill_id: 1 } );
    await col.createIndex( { skill_id: 1, version: 1 }, { unique: true } );
    return col;
  }

  // ─── Skills CRUD ─────────────────────────────────────

  async createSkill( params: {
    name: string;
    description?: string;
    display_title?: string;
    source?: string;
    default_version?: string;
  } ): Promise<SkillRecord> {
    return createSkillRecord( () => this.skills(), params );
  }

  async getSkill( skillId: string ): Promise<SkillRecord | null> {
    return getSkillById( () => this.skills(), skillId );
  }

  async listSkills( options: {
    limit?: number;
    page?: string;
    source?: string;
  } = {} ): Promise<AnthropicPageResponse<SkillRecord>> {
    return listSkillRecords( () => this.skills(), options );
  }

  async deleteSkill( skillId: string ): Promise<boolean> {
    return deleteSkillRecord( () => this.skills(), () => this.versions(), skillId );
  }

  // ─── Skill Versions CRUD ────────────────────────────

  async createSkillVersion( params: {
    skill_id: string;
    name?: string;
    description?: string;
    directory?: string;
    content?: Buffer;
    contentSize?: number;
  } ): Promise<SkillVersionRecord> {
    return createSkillVersionRecord( () => this.versions(), () => this.skills(), params );
  }

  async getSkillVersion( skillId: string, version: string ): Promise<SkillVersionRecord | null> {
    return getSkillVersionRecord( () => this.versions(), skillId, version );
  }

  async listSkillVersions( skillId: string, options: {
    limit?: number;
    page?: string;
  } = {} ): Promise<AnthropicPageResponse<SkillVersionRecord>> {
    return listSkillVersionRecords( () => this.versions(), skillId, options );
  }

  async deleteSkillVersion( skillId: string, version: string ): Promise<boolean> {
    return deleteSkillVersionRecord( () => this.versions(), skillId, version );
  }

  async getSkillVersionContent( skillId: string, version: string ): Promise<Buffer | null> {
    return getVersionContent( () => this.versions(), skillId, version );
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
