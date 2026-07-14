/**
 * SkillsProxy — Anthropic-compatible Hono router for /skills, /skill-versions, /files.
 *
 * Mount at /anthropic to serve:
 *   GET    /anthropic/skills
 *   POST   /anthropic/skills
 *   GET    /anthropic/skills/{skill_id}
 *   DELETE /anthropic/skills/{skill_id}
 *   GET    /anthropic/skills/{skill_id}/versions
 *   POST   /anthropic/skills/{skill_id}/versions
 *   GET    /anthropic/skills/{skill_id}/versions/{version}
 *   DELETE /anthropic/skills/{skill_id}/versions/{version}
 *   GET    /anthropic/skills/{skill_id}/versions/{version}/content
 *   GET    /anthropic/files
 *   POST   /anthropic/files
 *   GET    /anthropic/files/{file_id}
 *   GET    /anthropic/files/{file_id}/content
 *   DELETE /anthropic/files/{file_id}
 */
import { Hono } from 'hono';
import { getSkillStore, type SkillStore } from '../storage/SkillStore';
import { getFileStore, type FileStore } from '../storage/FileStore';
import type { StorageConfig } from '../storage/types';
import { setupSkillRoutes } from './skillRoutes';
import { setupSkillVersionRoutes } from './skillVersionRoutes';
import { setupFileRoutes } from './fileRoutes';

export class SkillsProxy {
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
      throw new Error(
        'SkillsProxy not initialized — configure storage.mongo_uri and storage.s3 in model.jsonc',
      );
    }
  }

  private setupRoutes(): void {
    const self = this;
    const stores = {
      get skillStore(): SkillStore { return self.skillStore; },
      get fileStore(): FileStore { return self.fileStore; },
      requireStores(): void { self.requireStores(); },
    };

    setupSkillRoutes( this.app, stores );
    setupSkillVersionRoutes( this.app, stores );
    setupFileRoutes( this.app, stores );
  }
}

// Singleton
export const skillsProxy = new SkillsProxy();
