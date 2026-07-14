/**
 * OpenAI format transformers (shared by OpenAI skill/file route handlers).
 */
import type { SkillRecord, SkillVersionRecord, FileRecord } from '../storage/types';

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

export { toOpenAISkill, toOpenAISkillVersion, toOpenAIFile, openAIListResponse };
