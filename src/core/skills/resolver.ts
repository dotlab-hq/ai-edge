/**
 * SkillResolver — singleton storage state + low-level resolve helpers.
 *
 * The request-body resolvers (resolveAnthropicBody / resolveOpenAIBody) live in
 * resolveAnthropic.ts / resolveOpenAI.ts and consume these helpers.
 */
import { getSkillStore, type SkillStore } from '../storage/SkillStore';
import { getFileStore, type FileStore } from '../storage/FileStore';
import type { StorageConfig } from '../storage/types';

// ─── Singleton state ────────────────────────────────────

let _skillStore: SkillStore | null = null;
let _fileStore: FileStore | null = null;
let _initialized = false;

/** Initialize the resolver with storage config. Called once at startup. */
export function initSkillResolver( storage?: StorageConfig ): void {
  if ( !storage || _initialized ) return;
  _skillStore = getSkillStore( storage.mongo_uri );
  _fileStore = getFileStore( storage.mongo_uri );
  _skillStore.ensureS3( storage.s3 );
  _fileStore.ensureS3( storage.s3 );
  _initialized = true;
}

/** Returns true if storage is configured and resolver is ready. */
export function isSkillResolverReady(): boolean {
  return _initialized;
}

// ─── Internal helpers (consumed by the body resolvers) ──

/**
 * Resolve a skill's content from the store.
 * Fetches the skill record, determines the active version, and downloads the content.
 */
export async function resolveSkillContent( skillId: string ): Promise<string | null> {
  if ( !_skillStore ) return null;
  try {
    const skill = await _skillStore.getSkill( skillId );
    if ( !skill ) return null;
    const version = skill.default_version || skill.latest_version;
    if ( !version ) return null;
    const contentBuf = await _skillStore.getSkillVersionContent( skillId, version );
    if ( !contentBuf ) return null;
    return contentBuf.toString( 'utf-8' );
  } catch ( err: any ) {
    console.error( `[SkillResolver] resolveSkillContent(${skillId}) error:`, err?.message || String( err ) );
    return null;
  }
}

/**
 * Resolve a file's binary content from the store.
 * Returns the buffer, MIME type, and filename.
 */
export async function resolveFileBinary( fileId: string ): Promise<{ body: Buffer; mimeType: string; filename: string } | null> {
  if ( !_fileStore ) return null;
  try {
    console.log( `[SkillResolver] resolveFileBinary(${fileId}) calling _fileStore.getFileContent...` );
    const fileContent = await _fileStore.getFileContent( fileId );
    if ( !fileContent ) {
      console.error( `[SkillResolver] resolveFileBinary(${fileId}) → getFileContent returned null` );
      return null;
    }
    console.log( `[SkillResolver] resolveFileBinary(${fileId}) → OK (${fileContent.contentType}, ${fileContent.sizeBytes} bytes)` );
    return {
      body: fileContent.body,
      mimeType: fileContent.contentType,
      filename: fileContent.filename,
    };
  } catch ( err: any ) {
    console.error( `[SkillResolver] resolveFileBinary(${fileId}) error:`, err?.message || String( err ) );
    return null;
  }
}

/**
 * Resolve a file's text content from the store.
 */
export async function resolveFileText( fileId: string ): Promise<{ text: string; mimeType: string; filename: string } | null> {
  const binary = await resolveFileBinary( fileId );
  if ( !binary ) return null;
  return {
    text: binary.body.toString( 'utf-8' ),
    mimeType: binary.mimeType,
    filename: binary.filename,
  };
}

/**
 * Resolve a file and return as base64 data with MIME type.
 * Used for image and document blocks that need base64-encoded content.
 */
export async function resolveFileBase64( fileId: string ): Promise<{ data: string; media_type: string } | null> {
  const binary = await resolveFileBinary( fileId );
  if ( !binary ) return null;
  return {
    data: binary.body.toString( 'base64' ),
    media_type: binary.mimeType,
  };
}

/**
 * Check if a MIME type represents an image.
 */
export function isImageMime( mime: string ): boolean {
  return mime.startsWith( 'image/' );
}
