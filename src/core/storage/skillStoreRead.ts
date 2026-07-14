/**
 * Read operations for SkillStore, extracted as standalone functions.
 */
import { type Collection, type Filter, type Sort } from 'mongodb';
import { s3GetObject } from './S3Client';
import {
  type SkillRecord,
  type SkillVersionRecord,
  type AnthropicPageResponse,
  encodePageToken,
  decodePageToken,
} from './types';

export async function getSkillById(
  col: () => Promise<Collection<SkillRecord>>,
  skillId: string,
): Promise<SkillRecord | null> {
  return ( await col() ).findOne( { id: skillId } );
}

export async function listSkillRecords(
  col: () => Promise<Collection<SkillRecord>>,
  options: { limit?: number; page?: string; source?: string },
): Promise<AnthropicPageResponse<SkillRecord>> {
  const c = await col();
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

  const results = await c
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

export async function getSkillVersionRecord(
  col: () => Promise<Collection<SkillVersionRecord>>,
  skillId: string,
  version: string,
): Promise<SkillVersionRecord | null> {
  return ( await col() ).findOne( { skill_id: skillId, version } );
}

export async function listSkillVersionRecords(
  col: () => Promise<Collection<SkillVersionRecord>>,
  skillId: string,
  options: { limit?: number; page?: string },
): Promise<AnthropicPageResponse<SkillVersionRecord>> {
  const c = await col();
  const limit = Math.min( Math.max( options.limit ?? 20, 1 ), 1000 );

  const filter: Filter<SkillVersionRecord> = { skill_id: skillId };

  if ( options.page ) {
    const cursor = decodePageToken( options.page );
    filter.version = { $lt: cursor } as any;
  }

  const results = await c
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

export async function getVersionContent(
  versionsCol: () => Promise<Collection<SkillVersionRecord>>,
  skillId: string,
  version: string,
): Promise<Buffer | null> {
  const record = await getSkillVersionRecord( versionsCol, skillId, version );
  if ( !record || !record._s3Key ) return null;

  try {
    const { body } = await s3GetObject( record._s3Key );
    return body;
  } catch {
    return null;
  }
}
