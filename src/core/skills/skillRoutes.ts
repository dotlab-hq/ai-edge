/**
 * Anthropic-compatible /skills route handlers.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { SkillStore } from '../storage/SkillStore';
import type { FileStore } from '../storage/FileStore';

interface Stores {
  skillStore: SkillStore;
  fileStore: FileStore;
  requireStores(): void;
}

export function setupSkillRoutes( app: Hono, stores: Stores ): void {
  const listSkills = async ( c: Context ) => {
    try {
      stores.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || undefined;
      const page = c.req.query( 'page' ) || undefined;
      const source = c.req.query( 'source' ) || undefined;
      const result = await stores.skillStore.listSkills( { limit, page, source } );
      return c.json( result );
    } catch ( error: any ) {
      console.error( '[/v1/skills] listSkills error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const createSkill = async ( c: Context ) => {
    try {
      stores.requireStores();
      const body = await c.req.json().catch( () => ({} ) );
      if ( !body.name ) {
        return c.json( { error: { message: 'name is required', type: 'invalid_request_error' } }, 400 );
      }
      const skill = await stores.skillStore.createSkill( {
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
  };

  const getSkill = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const skill = await stores.skillStore.getSkill( skillId );
      if ( !skill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( skill );
    } catch ( error: any ) {
      console.error( '[/v1/skills] getSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  const deleteSkill = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const deleted = await stores.skillStore.deleteSkill( skillId );
      if ( !deleted ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'not_found_error' } }, 404 );
      }
      return c.json( { id: skillId, deleted: true } );
    } catch ( error: any ) {
      console.error( '[/v1/skills] deleteSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'api_error' } }, 500 );
    }
  };

  // Register both /v1/skills and /skills
  app.get( '/v1/skills', ( c ) => listSkills( c ) );
  app.post( '/v1/skills', ( c ) => createSkill( c ) );
  app.get( '/v1/skills/:skill_id', ( c ) => getSkill( c ) );
  app.delete( '/v1/skills/:skill_id', ( c ) => deleteSkill( c ) );
  app.get( '/skills', ( c ) => listSkills( c ) );
  app.post( '/skills', ( c ) => createSkill( c ) );
  app.get( '/skills/:skill_id', ( c ) => getSkill( c ) );
  app.delete( '/skills/:skill_id', ( c ) => deleteSkill( c ) );
}
