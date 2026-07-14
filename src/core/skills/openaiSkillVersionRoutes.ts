/**
 * OpenAI-compatible /skills/:skill_id/versions route handlers.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { SkillStore } from '../storage/SkillStore';
import { toOpenAISkillVersion, openAIListResponse } from './openaiTransformers';

interface Stores {
  skillStore: SkillStore;
  requireStores(): void;
}

export function setupOpenAISkillVersionRoutes( app: Hono, stores: Stores ): void {
  const listSkillVersions = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const limit = Number( c.req.query( 'limit' ) ) || 20;
      const after = c.req.query( 'after' ) || undefined;
      const order = c.req.query( 'order' ) === 'asc' ? 'asc' : 'desc';

      let page: string | undefined;
      if ( after ) {
        const afterVer = await stores.skillStore.getSkillVersion( skillId, after );
        if ( afterVer ) {
          page = Buffer.from( afterVer.version, 'utf-8' ).toString( 'base64url' );
        }
      }

      const result = await stores.skillStore.listSkillVersions( skillId as string, { limit, page } );
      const versions = result.data.map( toOpenAISkillVersion );

      if ( order === 'asc' ) {
        versions.reverse();
      }

      return c.json( openAIListResponse( versions, result.has_more ) );
    } catch ( error: any ) {
      console.error( '[/skills/versions] listSkillVersions error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const createSkillVersion = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;

      const parentSkill = await stores.skillStore.getSkill( skillId );
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
        const body = await c.req.json().catch( () => ({} ) );
        if ( body.content ) {
          content = Buffer.from( typeof body.content === 'string' ? body.content : JSON.stringify( body.content ) );
          contentSize = content.length;
        }
      }

      const version = await stores.skillStore.createSkillVersion( {
        skill_id: skillId as string,
        content,
        contentSize,
      } );

      return c.json( toOpenAISkillVersion( version ), 201 );
    } catch ( error: any ) {
      console.error( '[/skills/versions] createSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const getSkillVersion = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const record = await stores.skillStore.getSkillVersion( skillId, version );
      if ( !record ) {
        return c.json( { error: { message: `Skill version not found: ${skillId}@${version}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( toOpenAISkillVersion( record ) );
    } catch ( error: any ) {
      console.error( '[/skills/versions] getSkillVersion error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const deleteSkillVersion = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const deleted = await stores.skillStore.deleteSkillVersion( skillId, version );
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
  };

  const getSkillVersionContent = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const version = c.req.param( 'version' ) as string;
      const content = await stores.skillStore.getSkillVersionContent( skillId, version );
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
  };

  app.get( '/skills/:skill_id/versions', ( c ) => listSkillVersions( c ) );
  app.post( '/skills/:skill_id/versions', ( c ) => createSkillVersion( c ) );
  app.get( '/skills/:skill_id/versions/:version', ( c ) => getSkillVersion( c ) );
  app.delete( '/skills/:skill_id/versions/:version', ( c ) => deleteSkillVersion( c ) );
  app.get( '/skills/:skill_id/versions/:version/content', ( c ) => getSkillVersionContent( c ) );
}
