/**
 * OpenAISkillsProxy — OpenAI-compatible Hono router for /skills, /files.
 *
 * Routes (all under root mount path, e.g. "/" or "/openai"):
 *   GET    /skills
 *   POST   /skills
 *   GET    /skills/{skill_id}
 *   POST   /skills/{skill_id}        (update default_version)
 *   DELETE /skills/{skill_id}
 *   GET    /skills/{skill_id}/versions
 *   POST   /skills/{skill_id}/versions
 *   GET    /skills/{skill_id}/versions/{version}
 *   DELETE /skills/{skill_id}/versions/{version}
 *   GET    /skills/{skill_id}/versions/{version}/content
 *   GET    /files
 *   POST   /files
 *   GET    /files/{file_id}
 *   GET    /files/{file_id}/content
 *   DELETE /files/{file_id}
 *
 * All responses use OpenAI format (unix timestamps, `object` field, `{ data, has_more, first_id, last_id }` lists).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getSkillStore, type SkillStore } from './storage/SkillStore';
import { getFileStore, type FileStore } from './storage/FileStore';
import type { StorageConfig, SkillRecord, SkillVersionRecord, FileRecord } from './storage/types';

// ─── OpenAI format transformers ────────────────────────

function toOpenAISkill( r: SkillRecord ) {
  return {
    id: r.id,
    created_at: Math.floor( new Date( r.created_at ).getTime() / 1000 ),
    default_version: r.default_version,
    description: r.description,
    latest_version: r.latest_version,
    name: r.name,
    object: 'skill' as const,
  };
}

function toOpenAISkillVersion( r: SkillVersionRecord ) {
  return {
    id: r.id,
    created_at: Math.floor( new Date( r.created_at ).getTime() / 1000 ),
    description: r.description,
    name: r.name,
    object: 'skill.version' as const,
    skill_id: r.skill_id,
    version: r.version,
  };
}

function toOpenAIFile( r: FileRecord ) {
  return {
    id: r.id,
    bytes: r.size_bytes,
    created_at: r.created_at,
    filename: r.filename,
    object: 'file' as const,
    purpose: r.purpose,
    status: r.status,
  };
}

function openAIListResponse<T extends { id: string }>( items: T[], hasMore: boolean ) {
  return {
    object: 'list' as const,
    data: items,
    first_id: items.length > 0 ? items[0]!.id : null,
    last_id: items.length > 0 ? items[items.length - 1]!.id : null,
    has_more: hasMore,
  };
}

// ─── OpenAI SkillsProxy class ─────────────────────────

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
    // ─── Skills ────────────────────────────────────────
    this.app.get( '/skills', ( c: Context ) => this.listSkills( c ) );
    this.app.post( '/skills', ( c: Context ) => this.createSkill( c ) );
    this.app.get( '/skills/:skill_id', ( c: Context ) => this.getSkill( c ) );
    this.app.post( '/skills/:skill_id', ( c: Context ) => this.updateSkill( c ) );
    this.app.delete( '/skills/:skill_id', ( c: Context ) => this.deleteSkill( c ) );

    // ─── Skill Versions ───────────────────────────────
    this.app.get( '/skills/:skill_id/versions', ( c: Context ) => this.listSkillVersions( c ) );
    this.app.post( '/skills/:skill_id/versions', ( c: Context ) => this.createSkillVersion( c ) );
    this.app.get( '/skills/:skill_id/versions/:version', ( c: Context ) => this.getSkillVersion( c ) );
    this.app.delete( '/skills/:skill_id/versions/:version', ( c: Context ) => this.deleteSkillVersion( c ) );
    this.app.get( '/skills/:skill_id/versions/:version/content', ( c: Context ) => this.getSkillVersionContent( c ) );

    // ─── Files ─────────────────────────────────────────
    this.app.get( '/files', ( c: Context ) => this.listFiles( c ) );
    this.app.post( '/files', ( c: Context ) => this.uploadFile( c ) );
    this.app.get( '/files/:file_id', ( c: Context ) => this.getFile( c ) );
    this.app.get( '/files/:file_id/content', ( c: Context ) => this.downloadFile( c ) );
    this.app.delete( '/files/:file_id', ( c: Context ) => this.deleteFile( c ) );
  }

  // ─── Skills Handlers ──────────────────────────────────

  private async listSkills( c: Context ) {
    try {
      this.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || 20;
      const after = c.req.query( 'after' ) || undefined;
      const order = c.req.query( 'order' ) === 'asc' ? 'asc' : 'desc';

      // Build a page token from `after` skill id
      let page: string | undefined;
      if ( after ) {
        const afterSkill = await this.skillStore.getSkill( after );
        if ( afterSkill ) {
          page = Buffer.from( afterSkill.created_at, 'utf-8' ).toString( 'base64url' );
        }
      }

      const result = await this.skillStore.listSkills( { limit, page } );
      const skills = result.data.map( toOpenAISkill );

      // Re-sort for asc order
      if ( order === 'asc' ) {
        skills.reverse();
      }

      return c.json( openAIListResponse( skills, result.has_more ) );
    } catch ( error: any ) {
      console.error( '[/skills] listSkills error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async createSkill( c: Context ) {
    try {
      this.requireStores();
      const body = await c.req.json().catch( () => ( {} ) );
      if ( !body.name && !body.files ) {
        return c.json( { error: { message: 'name or files is required', type: 'invalid_request_error' } }, 400 );
      }
      const skill = await this.skillStore.createSkill( {
        name: body.name ?? 'Unnamed Skill',
        description: body.description,
      } );
      return c.json( toOpenAISkill( skill ), 201 );
    } catch ( error: any ) {
      console.error( '[/skills] createSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async getSkill( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const skill = await this.skillStore.getSkill( skillId );
      if ( !skill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( toOpenAISkill( skill ) );
    } catch ( error: any ) {
      console.error( '[/skills] getSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async updateSkill( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const body = await c.req.json().catch( () => ( {} ) );
      const skill = await this.skillStore.getSkill( skillId );
      if ( !skill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'invalid_request_error' } }, 404 );
      }

      // Update default_version if provided
      if ( body.default_version ) {
        const versionsCol = await ( this.skillStore as any ).versions();
        const ver = await versionsCol.findOne( { skill_id: skillId, version: body.default_version } );
        if ( !ver ) {
          return c.json( { error: { message: `Version not found: ${body.default_version}`, type: 'invalid_request_error' } }, 404 );
        }
        // Update via store internals
        const db = await ( this.skillStore as any ).dbPromise;
        await db.collection( 'skills' ).updateOne( { id: skillId }, { $set: { default_version: body.default_version } } );
        skill.default_version = body.default_version;
      }

      return c.json( toOpenAISkill( skill ) );
    } catch ( error: any ) {
      console.error( '[/skills] updateSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async deleteSkill( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const deleted = await this.skillStore.deleteSkill( skillId );
      if ( !deleted ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( { id: skillId, deleted: true, object: 'skill.deleted' as const } );
    } catch ( error: any ) {
      console.error( '[/skills] deleteSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  // ─── Skill Versions Handlers ──────────────────────────

  private async listSkillVersions( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const limit = Number( c.req.query( 'limit' ) ) || 20;
      const after = c.req.query( 'after' ) || undefined;
      const order = c.req.query( 'order' ) === 'asc' ? 'asc' : 'desc';

      let page: string | undefined;
      if ( after ) {
        const afterVer = await this.skillStore.getSkillVersion( skillId, after );
        if ( afterVer ) {
          page = Buffer.from( afterVer.version, 'utf-8' ).toString( 'base64url' );
        }
      }

      const result = await this.skillStore.listSkillVersions( skillId as string, { limit, page } );
      const versions = result.data.map( toOpenAISkillVersion );

      if ( order === 'asc' ) {
        versions.reverse();
      }

      return c.json( openAIListResponse( versions, result.has_more ) );
    } catch ( error: any ) {
      console.error( '[/skills/versions] listSkillVersions error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async createSkillVersion( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;

      const parentSkill = await this.skillStore.getSkill( skillId );
      if ( !parentSkill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'invalid_request_error' } }, 404 );
      }

      const contentType = c.req.header( 'content-type' ) ?? '';
      let content: Buffer | undefined;
      let contentSize: number | undefined;

      if ( contentType.includes( 'multipart/form-data' ) ) {
        const formData = await c.req.formData();
        const file = formData.get( 'file' ) || formData.get( 'content' );
        if ( file instanceof File ) {
          const arrayBuffer = await file.arrayBuffer();
          content = Buffer.from( arrayBuffer );
          contentSize = content.length;
        }
      } else {
        const body = await c.req.json().catch( () => ( {} ) );
        if ( body.content ) {
          content = Buffer.from( typeof body.content === 'string' ? body.content : JSON.stringify( body.content ) );
          contentSize = content.length;
        }
      }

      const version = await this.skillStore.createSkillVersion( {
        skill_id: skillId as string,
        content,
        contentSize,
      } );

      return c.json( toOpenAISkillVersion( version ), 201 );
    } catch ( error: any ) {
      console.error( '[/skills/versions] createSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async getSkillVersion( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const record = await this.skillStore.getSkillVersion( skillId, version );
      if ( !record ) {
        return c.json( { error: { message: `Skill version not found: ${skillId}@${version}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( toOpenAISkillVersion( record ) );
    } catch ( error: any ) {
      console.error( '[/skills/versions] getSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async deleteSkillVersion( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const deleted = await this.skillStore.deleteSkillVersion( skillId, version );
      if ( !deleted ) {
        return c.json( { error: { message: `Skill version not found: ${skillId}@${version}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( {
        id: `${skillId}@${version}`,
        deleted: true,
        object: 'skill.version.deleted' as const,
        version,
      } );
    } catch ( error: any ) {
      console.error( '[/skills/versions] deleteSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async getSkillVersionContent( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const content = await this.skillStore.getSkillVersionContent( skillId, version );
      if ( !content ) {
        return c.json( { error: { message: `Content not found: ${skillId}@${version}`, type: 'invalid_request_error' } }, 404 );
      }
      c.header( 'Content-Type', 'application/zip' );
      c.header( 'Content-Disposition', `attachment; filename="skill-${skillId}-v${version}.zip"` );
      return c.body( new Uint8Array( content ) );
    } catch ( error: any ) {
      console.error( '[/skills/versions/content] getSkillVersionContent error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  // ─── Files Handlers ───────────────────────────────────

  private async listFiles( c: Context ) {
    try {
      this.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || 10000;
      const after = c.req.query( 'after' ) || undefined;
      const purpose = c.req.query( 'purpose' ) || undefined;

      let page_token: string | undefined;
      if ( after ) {
        // Convert `after` file_id to a page token
        const afterFile = await this.fileStore.getFile( after );
        if ( afterFile ) {
          page_token = Buffer.from( String( afterFile.created_at ), 'utf-8' ).toString( 'base64url' );
        }
      }

      const result = await this.fileStore.listFiles( { limit, purpose, page_token } );
      const files = result.data.map( toOpenAIFile );

      return c.json( openAIListResponse( files, result.has_more ) );
    } catch ( error: any ) {
      console.error( '[/files] listFiles error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async uploadFile( c: Context ) {
    try {
      this.requireStores();
      const contentType = c.req.header( 'content-type' ) ?? '';

      if ( contentType.includes( 'multipart/form-data' ) ) {
        const formData = await c.req.formData();
        const file = formData.get( 'file' );
        const purpose = formData.get( 'purpose' )?.toString() ?? 'user_data';
        const downloadable = formData.get( 'downloadable' )?.toString() === 'true';

        if ( !( file instanceof File ) ) {
          return c.json( { error: { message: 'file is required in multipart form data', type: 'invalid_request_error' } }, 400 );
        }

        const arrayBuffer = await file.arrayBuffer();
        const content = Buffer.from( arrayBuffer );
        const record = await this.fileStore.uploadFile( {
          filename: file.name,
          mimeType: file.type || undefined,
          purpose,
          content,
          downloadable,
        } );
        return c.json( toOpenAIFile( record ), 201 );
      } else {
        return c.json( { error: { message: 'Content-Type must be multipart/form-data', type: 'invalid_request_error' } }, 400 );
      }
    } catch ( error: any ) {
      console.error( '[/files] uploadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async getFile( c: Context ) {
    try {
      this.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const record = await this.fileStore.getFile( fileId );
      if ( !record ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( toOpenAIFile( record ) );
    } catch ( error: any ) {
      console.error( '[/files] getFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async downloadFile( c: Context ) {
    try {
      this.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const fileContent = await this.fileStore.getFileContent( fileId );
      if ( !fileContent ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'invalid_request_error' } }, 404 );
      }
      c.header( 'Content-Type', fileContent.contentType );
      c.header( 'Content-Length', String( fileContent.sizeBytes ) );
      c.header( 'Content-Disposition', `attachment; filename="${fileContent.filename}"` );
      return c.body( new Uint8Array( fileContent.body ) );
    } catch ( error: any ) {
      console.error( '[/files/content] downloadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }

  private async deleteFile( c: Context ) {
    try {
      this.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const deleted = await this.fileStore.deleteFile( fileId );
      if ( !deleted ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( { id: fileId, object: 'file.deleted' as const, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/files] deleteFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  }
}

// Singleton
export const openAISkillsProxy = new OpenAISkillsProxy();
