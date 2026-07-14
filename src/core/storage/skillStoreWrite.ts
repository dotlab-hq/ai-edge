/**
 * Write operations for SkillStore (skills & skill versions).
 *
 * Extracted as standalone functions; the SkillStore class delegates to them.
 */
import { type Collection } from 'mongodb';
import { s3PutObject, s3DeleteObject } from './S3Client';
import {
  type SkillRecord,
  type SkillVersionRecord,
  generateSkillId,
  generateSkillVersionId,
  generateFileVersion,
} from './types';

export async function createSkillRecord(
  skillsCol: () => Promise<Collection<SkillRecord>>,
  params: {
    name: string;
    description?: string;
    display_title?: string;
    source?: string;
    default_version?: string;
  },
): Promise<SkillRecord> {
  const col = await skillsCol();
  const now = new Date().toISOString();
  const id = generateSkillId();

  const record: SkillRecord = {
    id,
    created_at: now,
    display_title: params.display_title ?? params.name,
    name: params.name,
    description: params.description ?? '',
    latest_version: '',
    source: params.source ?? 'custom',
    default_version: params.default_version ?? '',
    _formats: ['anthropic', 'openai'],
  };

  await col.insertOne( record );
  return record;
}

export async function deleteSkillRecord(
  skillsCol: () => Promise<Collection<SkillRecord>>,
  versionsCol: () => Promise<Collection<SkillVersionRecord>>,
  skillId: string,
): Promise<boolean> {
  const sCol = await skillsCol();
  const vCol = await versionsCol();

  const versions = await vCol.find( { skill_id: skillId } ).toArray();
  for ( const ver of versions ) {
    if ( ver._s3Key ) {
      await s3DeleteObject( ver._s3Key ).catch( () => {} );
    }
  }
  await vCol.deleteMany( { skill_id: skillId } );

  const result = await sCol.deleteOne( { id: skillId } );
  return result.deletedCount > 0;
}

export async function createSkillVersionRecord(
  versionsCol: () => Promise<Collection<SkillVersionRecord>>,
  skillsCol: () => Promise<Collection<SkillRecord>>,
  params: {
    skill_id: string;
    name?: string;
    description?: string;
    directory?: string;
    content?: Buffer;
    contentSize?: number;
  },
): Promise<SkillVersionRecord> {
  const vCol = await versionsCol();
  const sCol = await skillsCol();
  const version = generateFileVersion();
  const id = generateSkillVersionId();
  const now = new Date().toISOString();

  let s3Key = '';
  let contentSize = params.contentSize ?? 0;
  if ( params.content && params.content.length > 0 ) {
    s3Key = `skills/${params.skill_id}/versions/${version}/content`;
    contentSize = params.content.length;
    await s3PutObject( s3Key, params.content, 'application/zip' );
  }

  const record: SkillVersionRecord = {
    id,
    version,
    created_at: now,
    description: params.description ?? '',
    directory: params.directory ?? '',
    name: params.name ?? '',
    skill_id: params.skill_id,
    type: 'skill_version',
    _s3Key: s3Key,
    _contentSize: contentSize,
  };

  await vCol.insertOne( record );

  await sCol.updateOne(
    { id: params.skill_id },
    {
      $set: {
        latest_version: version,
        description: record.description || undefined,
      },
    }
  );

  return record;
}

export async function deleteSkillVersionRecord(
  versionsCol: () => Promise<Collection<SkillVersionRecord>>,
  skillId: string,
  version: string,
): Promise<boolean> {
  const col = await versionsCol();
  const record = await col.findOne( { skill_id: skillId, version } );
  if ( !record ) return false;

  if ( record._s3Key ) {
    await s3DeleteObject( record._s3Key ).catch( () => {} );
  }

  const result = await col.deleteOne( { _id: record._id } );
  return result.deletedCount > 0;
}
