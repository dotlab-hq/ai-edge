/**
 * OpenAI-compatible /skills route handlers.
 */
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { SkillStore } from '../storage/SkillStore';
import type { SkillRecord, SkillVersionRecord } from '../storage/types';
import { toOpenAISkill, toOpenAISkillVersion, openAIListResponse } from './openaiTransformers';

interface Stores {
  skillStore: SkillStore;
  requireStores(): void;
}

export function setupOpenAISkillRoutes( app: Hono, stores: Stores ): void {
  const listSkills = async ( c: Context ) => {
    try {
      stores.requireStores();
      const limit = Number( c.req.query( 'limit' ) ) || 20;
      const after = c.req.query( 'after' ) || undefined;
      const order = c.req.query( 'order' ) === 'asc' ? 'asc' : 'desc';

      let page: string | undefined;
      if ( after ) {
        const afterSkill = await stores.skillStore.getSkill( after );
        if ( afterSkill ) {
          page = Buffer.from( afterSkill.created_at, 'utf-8' ).toString( 'base64url' );
        }
      }

      const result = await stores.skillStore.listSkills( { limit, page } );
      const skills = result.data.map( toOpenAISkill );

      if ( order === 'asc' ) {
        skills.reverse();
      }

      return c.json( openAIListResponse( skills, result.has_more ) );
    } catch ( error: any ) {
      console.error( '[/skills] listSkills error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const createSkill = async ( c: Context ) => {
    try {
      stores.requireStores();
      const body = await c.req.json().catch( () => ({} ) );
      if ( !body.name && !body.files ) {
        return c.json( { error: { message: 'name or files is required', type: 'invalid_request_error' } }, 400 );
      }
      const skill = await stores.skillStore.createSkill( {
        name: body.name ?? 'Unnamed Skill',
        description: body.description,
      } );
      return c.json( toOpenAISkill( skill ), 201 );
    } catch ( error: any ) {
      console.error( '[/skills] createSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const getSkill = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const skill = await stores.skillStore.getSkill( skillId );
      if ( !skill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( toOpenAISkill( skill ) );
    } catch ( error: any ) {
      console.error( '[/skills] getSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const updateSkill = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const body = await c.req.json().catch( () => ({} ) );
      const skill = await stores.skillStore.getSkill( skillId );
      if ( !skill ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'invalid_request_error' } }, 404 );
      }

      // Update default_version if provided
      if ( body.default_version ) {
        const versionsCol = await ( stores.skillStore as any ).versions();
        const ver = await versionsCol.findOne( { skill_id: skillId, version: body.default_version } );
        if ( !ver ) {
          return c.json( { error: { message: `Version not found: ${body.default_version}`, type: 'invalid_request_error' } }, 404 );
        }
        // Update via store internals
        const db = await ( stores.skillStore as any ).dbPromise;
        await db.collection( 'skills' ).updateOne( { id: skillId }, { $set: { default_version: body.default_version } } );
        skill.default_version = body.default_version;
      }

      return c.json( toOpenAISkill( skill ) );
    } catch ( error: any ) {
      console.error( '[/skills] updateSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  const deleteSkill = async ( c: Context ) => {
    try {
      stores.requireStores();
      const skillId = c.req.param( 'skill_id' ) as string;
      const deleted = await stores.skillStore.deleteSkill( skillId );
      if ( !deleted ) {
        return c.json( { error: { message: `Skill not found: ${skillId}`, type: 'invalid_request_error' } }, 404 );
      }
      return c.json( { id: skillId, deleted: true, object: 'skill.deleted' as const } );
    } catch ( error: any ) {
      console.error( '[/skills] deleteSkill error:', error?.message || String( error ) );
      return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
  };

  app.get( '/skills', ( c ) => listSkills( c ) );
  app.post( '/skills', ( c ) => createSkill( c ) );
  app.get( '/skills/:skill_id', ( c ) => getSkill( c ) );
  app.post( '/skills/:skill_id', ( c ) => updateSkill( c ) );
  app.delete( '/skills/:skill_id', ( c ) => deleteSkill( c ) );
}
