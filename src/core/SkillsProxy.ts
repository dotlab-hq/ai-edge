/**
 * SkillsProxy — Anthropic-compatible Hono router for /v1/skills, /v1/skill-versions, /v1/files.
 *
 * Routes:
 *   GET    /v1/skills
 *   POST   /v1/skills
 *   GET    /v1/skills/{skill_id}
 *   DELETE /v1/skills/{skill_id}
 *   GET    /v1/skills/{skill_id}/versions
 *   POST   /v1/skills/{skill_id}/versions
 *   GET    /v1/skills/{skill_id}/versions/{version}
 *   DELETE /v1/skills/{skill_id}/versions/{version}
 *   GET    /v1/skills/{skill_id}/versions/{version}/content
 *   GET    /v1/files
 *   POST   /v1/files
 *   GET    /v1/files/{file_id}
 *   GET    /v1/files/{file_id}/content
 *   DELETE /v1/files/{file_id}
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { getSkillStore, type SkillStore } from './storage/SkillStore';
import { getFileStore, type FileStore } from './storage/FileStore';
import type { StorageConfig } from './storage/types';

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
      throw new Error( 'SkillsProxy not initialized — configure storage.mongo_uri and storage.s3 in model.jsonc' );
    }
  }

  private setupRoutes(): void {
    // ─── Skills ────────────────────────────────────────
    this.app.get( '/v1/skills', ( c: Context ) => this.listSkills( c ) );
    this.app.post( '/v1/skills', ( c: Context ) => this.createSkill( c ) );
    this.app.get( '/v1/skills/:skill_id', ( c: Context ) => this.getSkill( c ) );
    this.app.delete( '/v1/skills/:skill_id', ( c: Context ) => this.deleteSkill( c ) );

    // ─── Skill Versions ───────────────────────────────
    this.app.get( '/v1/skills/:skill_id/versions', ( c: Context ) => this.listSkillVersions( c ) );
    this.app.post( '/v1/skills/:skill_id/versions', ( c: Context ) => this.createSkillVersion( c ) );
    this.app.get( '/v1/skills/:skill_id/versions/:version', ( c: Context ) => this.getSkillVersion( c ) );
    this.app.delete( '/v1/skills/:skill_id/versions/:version', ( c: Context ) => this.deleteSkillVersion( c ) );
    this.app.get( '/v1/skills/:skill_id/versions/:version/content', ( c: Context ) => this.getSkillVersionContent( c ) );

    // ─── Files ─────────────────────────────────────────
    this.app.get( '/v1/files', ( c: Context ) => this.listFiles( c ) );
    this.app.post( '/v1/files', ( c: Context ) => this.uploadFile( c ) );
    this.app.get( '/v1/files/:file_id', ( c: Context ) => this.getFile( c ) );
    this.app.get( '/v1/files/:file_id/content', ( c: Context ) => this.downloadFile( c ) );
    this.app.delete( '/v1/files/:file_id', ( c: Context ) => this.deleteFile( c ) );
  }

  // ─── Skills Handlers ──────────────────────────────────

  private async listSkills( c: Context ) {
    try {
      this.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || undefined;
      const page = c.req.query( 'page' ) || undefined;
      const source = c.req.query( 'source' ) || undefined;
      const result = await this.skillStore.listSkills( { limit, page, source } );
      return c.json( result );
    } catch ( error: any ) {
      console.error( '[/v1/skills] listSkills error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async createSkill( c: Context ) {
    try {
      this.requireStores();
      const body = await c.req.json().catch( () => ( {} ) );
      if ( !body.name ) {
        return c.json( { error: { message: 'name is required', type: 'invalid_request_error' } }, 400 );
      }
      const skill = await this.skillStore.createSkill( {
        name: body.name,
        description: body.description,
        display_title: body.display_title,
        source: body.source,
        default_version: body.default_version,
      } );
      return c.json( skill, 201 );
    } catch ( error: any ) {
      console.error( '[/v1/skills] createSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async getSkill( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const skill = await this.skillStore.getSkill( skillId );
      if ( !skill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( skill );
    } catch ( error: any ) {
      console.error( '[/v1/skills] getSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async deleteSkill( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const deleted = await this.skillStore.deleteSkill( skillId );
      if ( !deleted ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( { id: skillId, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/v1/skills] deleteSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  // ─── Skill Versions Handlers ──────────────────────────

  private async listSkillVersions( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const limit = Number( c.req.query( 'limit' ) ) || undefined;
      const page = c.req.query( 'page' ) || undefined;
      const result = await this.skillStore.listSkillVersions( skillId, { limit, page } );
      return c.json( result );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions] listSkillVersions error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async createSkillVersion( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;

      // Check if the parent skill exists
      const parentSkill = await this.skillStore.getSkill( skillId );
      if ( !parentSkill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'not_found_error' } }, 404 );
      }

      // Handle multipart/form-data (file upload) or JSON body
      const contentType = c.req.header( 'content-type' ) ?? '';
      let content: Buffer | undefined;
      let contentSize: number | undefined;
      let name: string | undefined;
      let description: string | undefined;

      if ( contentType.includes( 'multipart/form-data' ) ) {
        const formData = await c.req.formData();
        const file = formData.get( 'file' ) || formData.get( 'content' );
        if ( file instanceof File ) {
          const arrayBuffer = await file.arrayBuffer();
          content = Buffer.from( arrayBuffer );
          contentSize = content.length;
        }
        name = formData.get( 'name' )?.toString();
        description = formData.get( 'description' )?.toString();
      } else {
        const body = await c.req.json().catch( () => ( {} ) );
        name = body.name;
        description = body.description;
        if ( body.content ) {
          content = Buffer.from( typeof body.content === 'string' ? body.content : JSON.stringify( body.content ) );
          contentSize = content.length;
        }
      }

      const version = await this.skillStore.createSkillVersion( {
        skill_id: skillId as string,
        name,
        description,
        content,
        contentSize,
      } );
      return c.json( version, 201 );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions] createSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async getSkillVersion( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const record = await this.skillStore.getSkillVersion( skillId, version );
      if ( !record ) {
        return c.json( { error: { message: `Skill version not found: ${skillId}@${version}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( record );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions] getSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async deleteSkillVersion( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const deleted = await this.skillStore.deleteSkillVersion( skillId, version );
      if ( !deleted ) {
        return c.json( { error: { message: `Skill version not found: ${skillId}@${version}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( { id: `${skillId}@${version}`, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions] deleteSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async getSkillVersionContent( c: Context ) {
    try {
      this.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const content = await this.skillStore.getSkillVersionContent( skillId, version );
      if ( !content ) {
        return c.json( { error: { message: `Content not found: ${skillId}@${version}`, type: 'not_found_error' } }, 404 );
      }
      c.header( 'Content-Type', 'application/zip' );
      c.header( 'Content-Disposition', `attachment; filename="skill-${skillId}-v${version}.zip"` );
      return c.body( new Uint8Array( content ) );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions/content] getSkillVersionContent error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  // ─── Files Handlers ───────────────────────────────────

  private async listFiles( c: Context ) {
    try {
      this.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || undefined;
      const after_id = c.req.query( 'after_id' ) || undefined;
      const before_id = c.req.query( 'before_id' ) || undefined;
      const scope_id = c.req.query( 'scope_id' ) || undefined;
      const result = await this.fileStore.listFiles( { limit, after_id, before_id, scope_id } );
      return c.json( result );
    } catch ( error: any ) {
      console.error( '[/v1/files] listFiles error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
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
        return c.json( record, 201 );
      } else {
        return c.json( { error: { message: 'Content-Type must be multipart/form-data', type: 'invalid_request_error' } }, 400 );
      }
    } catch ( error: any ) {
      console.error( '[/v1/files] uploadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async getFile( c: Context ) {
    try {
      this.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const record = await this.fileStore.getFile( fileId );
      if ( !record ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( record );
    } catch ( error: any ) {
      console.error( '[/v1/files] getFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async downloadFile( c: Context ) {
    try {
      this.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const fileContent = await this.fileStore.getFileContent( fileId );
      if ( !fileContent ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'not_found_error' } }, 404 );
      }
      c.header( 'Content-Type', fileContent.contentType );
      c.header( 'Content-Length', String( fileContent.sizeBytes ) );
      c.header( 'Content-Disposition', `attachment; filename="${fileContent.filename}"` );
      return c.body( new Uint8Array( fileContent.body ) );
    } catch ( error: any ) {
      console.error( '[/v1/files/content] downloadFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }

  private async deleteFile( c: Context ) {
    try {
      this.requireStores();
      const fileId = c.req.param( 'file_id' ) as string;
      const deleted = await this.fileStore.deleteFile( fileId );
      if ( !deleted ) {
        return c.json( { error: { message: `File not found: ${fileId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( { id: fileId, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/v1/files] deleteFile error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  }
}

// Singleton
export const skillsProxy = new SkillsProxy();
