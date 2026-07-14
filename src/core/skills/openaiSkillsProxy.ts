/**
 * OpenAISkillsProxy — OpenAI-compatible Hono router for /skills, /files.
 *
 * All responses use OpenAI format (unix timestamps, `object` field,
 * `{ data, has_more, first_id, last_id }` lists).
 */
import { Hono } from 'hono';
import { getSkillStore, type SkillStore } from '../storage/SkillStore';
import { getFileStore, type FileStore } from '../storage/FileStore';
import type { StorageConfig } from '../storage/types';
import { setupOpenAISkillRoutes } from './openaiSkillRoutes';
import { setupOpenAISkillVersionRoutes } from './openaiSkillVersionRoutes';
import { setupOpenAIFileRoutes } from './openaiFileRoutes';

export class OpenAISkillsProxy {
  private app: Hono;
  private skillStore!: SkillStore;
  private fileStore!: FileStore;
  private initialized = false;

  constructor() {
    this.app = new Hono();
    this.setupRoutes();
  }

  getApp(): Hono {
    return this.app;
  }

  initialize( storage?: StorageConfig ): void {
    if ( !storage || this.initialized ) return;
    this.skillStore = getSkillStore( storage.mongo_uri );
    this.fileStore = getFileStore( storage.mongo_uri );
    this.skillStore.ensureS3( storage.s3 );
    this.fileStore.ensureS3( storage.s3 );
    this.initialized = true;
  }

  private requireStores(): void {
    if ( !this.initialized ) {
      throw new Error( 'OpenAISkillsProxy not initialized — configure storage in model.jsonc' );
    }
  }

  private setupRoutes(): void {
    const self = this;
    const stores = {
      get skillStore(): SkillStore { return self.skillStore; },
      get fileStore(): FileStore { return self.fileStore; },
      requireStores(): void { self.requireStores(); },
    };

    setupOpenAISkillRoutes( this.app, stores );
    setupOpenAISkillVersionRoutes( this.app, stores );
    setupOpenAIFileRoutes( this.app, stores );
  }
}

// Singleton
export const openAISkillsProxy = new OpenAISkillsProxy();
