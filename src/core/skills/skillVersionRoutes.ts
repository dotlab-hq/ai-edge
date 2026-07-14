/**
 * Anthropic-compatible /skills/:skill_id/versions route handlers.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { SkillStore } from '../storage/SkillStore';

interface Stores {
  skillStore: SkillStore;
  requireStores(): void;
}

export function setupSkillVersionRoutes( app: Hono, stores: Stores ): void {
  const listSkillVersions = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const limit = Number( c.req.query( 'limit' ) ) || undefined;
      const page = c.req.query( 'page' ) || undefined;
      const result = await stores.skillStore.listSkillVersions( skillId, { limit, page } );
      return c.json( result );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions] listSkillVersions error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const createSkillVersion = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;

      const parentSkill = await stores.skillStore.getSkill( skillId );
      if ( !parentSkill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'not_found_error' } }, 404 );
      }

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
        const body = await c.req.json().catch( () => ({} ) );
        name = body.name;
        description = body.description;
        if ( body.content ) {
          content = Buffer.from(
            typeof body.content === 'string' ? body.content : JSON.stringify( body.content ),
          );
          contentSize = content.length;
        }
      }

      const version = await stores.skillStore.createSkillVersion( {
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
  };

  const getSkillVersion = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const record = await stores.skillStore.getSkillVersion( skillId, version );
      if ( !record ) {
        return c.json( { error: { message: `Skill version not found: ${skillId}@${version}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( record );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions] getSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const deleteSkillVersion = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const deleted = await stores.skillStore.deleteSkillVersion( skillId, version );
      if ( !deleted ) {
        return c.json( { error: { message: `Skill version not found: ${skillId}@${version}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( { id: `${skillId}@${version}`, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/v1/skills/versions] deleteSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const getSkillVersionContent = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const content = await stores.skillStore.getSkillVersionContent( skillId, version );
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
  };

  // Register /v1 and non-prefixed variants
  app.get( '/v1/skills/:skill_id/versions', ( c ) => listSkillVersions( c ) );
  app.post( '/v1/skills/:skill_id/versions', ( c ) => createSkillVersion( c ) );
  app.get( '/v1/skills/:skill_id/versions/:version', ( c ) => getSkillVersion( c ) );
  app.delete( '/v1/skills/:skill_id/versions/:version', ( c ) => deleteSkillVersion( c ) );
  app.get( '/v1/skills/:skill_id/versions/:version/content', ( c ) => getSkillVersionContent( c ) );
  app.get( '/skills/:skill_id/versions', ( c ) => listSkillVersions( c ) );
  app.post( '/skills/:skill_id/versions', ( c ) => createSkillVersion( c ) );
  app.get( '/skills/:skill_id/versions/:version', ( c ) => getSkillVersion( c ) );
  app.delete( '/skills/:skill_id/versions/:version', ( c ) => deleteSkillVersion( c ) );
  app.get( '/skills/:skill_id/versions/:version/content', ( c ) => getSkillVersionContent( c ) );
}
