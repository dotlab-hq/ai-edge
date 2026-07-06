/**
 * SkillResolver — Inference-layer middleware that detects skill and file references
 * in request bodies, resolves their content from MongoDB/S3, and injects the
 * resolved content before forwarding upstream.
 *
 * The upstream providers do NOT natively support skills or file references.
 * This layer makes it APPEAR as if they do by resolving references inline.
 *
 * ──── ANTHROPIC FORMAT ────
 *
 * File references in message content blocks:
 *   - {type: "document", source: {type: "file", file_id: "file_xxx"}}
 *     → resolve to {type: "document", source: {type: "base64", media_type, data}}
 *   - {type: "image", source: {type: "file", file_id: "file_xxx"}}
 *     → resolve to {type: "image", source: {type: "base64", media_type, data}}
 *   - {type: "container_upload", file_id: "file_xxx"}
 *     → resolve to inline document or image block
 *
 * Skills in request body:
 *   - body.container.skills: [{type: "anthropic"|"custom", skill_id, version}]
 *     → resolve skill content → inject as system context → strip from container
 *   - body.container.id: "..." → strip (upstream does not support)
 *
 * ──── OPENAI FORMAT ────
 *
 * File references in messages:
 *   - {type: "file", file_id: "file_xxx"} in message content parts
 *     → resolve to inline text content
 *
 * Skill tools:
 *   - {type: "function", name: "skill:<skill_id>"} → resolve → inject as system context
 *   - {type: "skill", skill_id: "..."} → resolve → inject as system context
 *
 * Responses API:
 *   - {type: "file", file_id} in input items → resolve to inline text
 */
import { getSkillStore, type SkillStore } from './storage/SkillStore';
import { getFileStore, type FileStore } from './storage/FileStore';
import type { StorageConfig } from './storage/types';

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

// ─── Internal helpers ───────────────────────────────────

/**
 * Resolve a skill's content from the store.
 * Fetches the skill record, determines the active version, and downloads the content.
 */
async function resolveSkillContent( skillId: string ): Promise<string | null> {
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
async function resolveFileBinary( fileId: string ): Promise<{ body: Buffer; mimeType: string; filename: string } | null> {
  if ( !_fileStore ) return null;
  try {
    const fileContent = await _fileStore.getFileContent( fileId );
    if ( !fileContent ) return null;
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
async function resolveFileText( fileId: string ): Promise<{ text: string; mimeType: string; filename: string } | null> {
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
async function resolveFileBase64( fileId: string ): Promise<{ data: string; media_type: string } | null> {
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
function isImageMime( mime: string ): boolean {
  return mime.startsWith( 'image/' );
}

// ─── Anthropic format ───────────────────────────────────

/**
 * Resolve all file and skill references in an Anthropic-format request body.
 *
 * File reference patterns in message content blocks:
 *   - {type: "document", source: {type: "file", file_id: "file_xxx"}}
 *   - {type: "image", source: {type: "file", file_id: "file_xxx"}}
 *   - {type: "container_upload", file_id: "file_xxx"}
 *
 * Skill reference pattern:
 *   - body.container.skills: [{type: "anthropic"|"custom", skill_id, version}]
 */
export async function resolveAnthropicBody( body: any ): Promise<void> {
  if ( !_initialized || !body ) return;

  const fileIds = new Set<string>();
  const skillRefs: Array<{ skill_id: string; version?: string }> = [];

  // ── 1. Scan messages for file references ──────────────
  if ( Array.isArray( body.messages ) ) {
    for ( const msg of body.messages ) {
      if ( !Array.isArray( msg.content ) ) continue;
      for ( const block of msg.content ) {
        // Document block with file source
        if ( block?.type === 'document' && block.source?.type === 'file' && block.source?.file_id ) {
          fileIds.add( block.source.file_id );
        }
        // Image block with file source
        if ( block?.type === 'image' && block.source?.type === 'file' && block.source?.file_id ) {
          fileIds.add( block.source.file_id );
        }
        // Container upload block
        if ( block?.type === 'container_upload' && block.file_id ) {
          fileIds.add( block.file_id );
        }
        // Scan tool_result content for nested file references
        if ( block?.type === 'tool_result' && Array.isArray( block.content ) ) {
          for ( const subBlock of block.content ) {
            if ( subBlock?.type === 'document' && subBlock.source?.type === 'file' && subBlock.source?.file_id ) {
              fileIds.add( subBlock.source.file_id );
            }
            if ( subBlock?.type === 'image' && subBlock.source?.type === 'file' && subBlock.source?.file_id ) {
              fileIds.add( subBlock.source.file_id );
            }
          }
        }
      }
    }
  }

  // ── 2. Scan container.skills for skill references ─────
  if ( body.container && Array.isArray( body.container.skills ) ) {
    for ( const skillRef of body.container.skills ) {
      if ( skillRef?.skill_id ) {
        skillRefs.push( { skill_id: skillRef.skill_id, version: skillRef.version } );
      }
    }
  }

  if ( fileIds.size === 0 && skillRefs.length === 0 ) return;

  // ── 3. Resolve skills and inject as system context ─────
  if ( skillRefs.length > 0 ) {
    const skillParts: string[] = [];
    for ( const ref of skillRefs ) {
      const content = await resolveSkillContent( ref.skill_id );
      if ( content ) {
        const versionLabel = ref.version && ref.version !== 'latest' ? ` v${ref.version}` : '';
        skillParts.push( `[Skill: ${ref.skill_id}${versionLabel}]\n${content}` );
      }
    }

    if ( skillParts.length > 0 ) {
      const skillBlock = `## Skills Context\nThe following skills have been loaded and are available for use:\n\n${skillParts.join( '\n\n---\n\n' )}`;
      // Inject as system message (prepend to existing system)
      if ( typeof body.system === 'string' ) {
        body.system = `${skillBlock}\n\n---\n\n${body.system}`;
      } else if ( Array.isArray( body.system ) ) {
        body.system.unshift( { type: 'text', text: skillBlock } );
      } else {
        body.system = skillBlock;
      }
    }

    // Strip skills from container (upstream does not support them)
    body.container.skills = [];
  }

  // ── 4. Strip container entirely if it's now empty ──────
  if ( body.container ) {
    const container = body.container;
    const hasContent = container.id || ( Array.isArray( container.skills ) && container.skills.length > 0 );
    if ( !hasContent ) {
      delete body.container;
    }
  }

  // ── 5. Resolve file references and replace blocks ──────
  if ( fileIds.size > 0 ) {
    // Build a cache of resolved files (base64 + metadata)
    const fileCache = new Map<string, { data: string; media_type: string; filename: string }>();
    for ( const fileId of fileIds ) {
      const base64 = await resolveFileBase64( fileId );
      const text = await resolveFileText( fileId );
      if ( base64 ) {
        fileCache.set( fileId, {
          data: base64.data,
          media_type: base64.media_type,
          filename: text?.filename ?? fileId,
        } );
      }
    }

    if ( fileCache.size === 0 ) return;

    // Replace file reference blocks in messages
    for ( const msg of body.messages ) {
      if ( !Array.isArray( msg.content ) ) continue;
      for ( let i = msg.content.length - 1; i >= 0; i-- ) {
        const block = msg.content[i];

        // Document block with file source → replace source with base64
        if ( block?.type === 'document' && block.source?.type === 'file' && block.source?.file_id ) {
          const cached = fileCache.get( block.source.file_id );
          if ( cached ) {
            msg.content[i] = {
              type: 'document',
              source: {
                type: 'base64',
                media_type: cached.media_type,
                data: cached.data,
              },
            };
          }
        }

        // Image block with file source → replace source with base64
        if ( block?.type === 'image' && block.source?.type === 'file' && block.source?.file_id ) {
          const cached = fileCache.get( block.source.file_id );
          if ( cached ) {
            msg.content[i] = {
              type: 'image',
              source: {
                type: 'base64',
                media_type: cached.media_type,
                data: cached.data,
              },
            };
          }
        }

        // Container upload block → replace with document or image
        if ( block?.type === 'container_upload' && block.file_id ) {
          const cached = fileCache.get( block.file_id );
          if ( cached ) {
            if ( isImageMime( cached.media_type ) ) {
              msg.content[i] = {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: cached.media_type,
                  data: cached.data,
                },
              };
            } else {
              msg.content[i] = {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: cached.media_type,
                  data: cached.data,
                },
              };
            }
          }
        }

        // Handle nested file references in tool_result blocks
        if ( block?.type === 'tool_result' && Array.isArray( block.content ) ) {
          for ( let j = block.content.length - 1; j >= 0; j-- ) {
            const subBlock = block.content[j];
            if ( subBlock?.type === 'document' && subBlock.source?.type === 'file' && subBlock.source?.file_id ) {
              const cached = fileCache.get( subBlock.source.file_id );
              if ( cached ) {
                block.content[j] = {
                  type: 'document',
                  source: { type: 'base64', media_type: cached.media_type, data: cached.data },
                };
              }
            }
            if ( subBlock?.type === 'image' && subBlock.source?.type === 'file' && subBlock.source?.file_id ) {
              const cached = fileCache.get( subBlock.source.file_id );
              if ( cached ) {
                block.content[j] = {
                  type: 'image',
                  source: { type: 'base64', media_type: cached.media_type, data: cached.data },
                };
              }
            }
          }
        }
      }
    }
  }
}

// ─── OpenAI format ──────────────────────────────────────

/**
 * Resolve all file and skill references in an OpenAI-format request body.
 *
 * File reference patterns:
 *   - {type: "file", file_id: "file_xxx"} in message content parts
 *   - {type: "file", file_id: "file_xxx"} in Responses API input items
 *
 * Skill reference patterns:
 *   - {type: "skill", skill_id: "..."} tool definition
 *   - {type: "function", name: "skill:<skill_id>"} tool definition
 */
export async function resolveOpenAIBody( body: any ): Promise<void> {
  if ( !_initialized || !body ) return;

  const fileIds = new Set<string>();
  const skillIds = new Set<string>();

  // ── 1. Scan tools for skill references ────────────────
  if ( Array.isArray( body.tools ) ) {
    for ( const tool of body.tools ) {
      // Explicit skill tool type
      if ( tool?.type === 'skill' && ( tool.skill_id || tool.id ) ) {
        skillIds.add( tool.skill_id || tool.id );
      }
      // Convention: function name starting with "skill:" references a stored skill
      if ( tool?.type === 'function' && typeof tool.function?.name === 'string' ) {
        const name = tool.function.name;
        if ( name.startsWith( 'skill:' ) ) {
          skillIds.add( name.slice( 6 ) );
        }
      }
    }
  }

  // ── 2. Scan messages for file references ──────────────
  if ( Array.isArray( body.messages ) ) {
    for ( const msg of body.messages ) {
      const content = msg?.content;
      if ( Array.isArray( content ) ) {
        for ( const part of content ) {
          if ( part?.type === 'file' && part.file_id ) {
            fileIds.add( part.file_id );
          }
          // OpenAI file_search results may have file references
          if ( part?.type === 'file_citation' && part.file_id ) {
            fileIds.add( part.file_id );
          }
        }
      }
    }
  }

  // Also scan Responses API `input` format
  if ( Array.isArray( body.input ) ) {
    for ( const item of body.input ) {
      if ( item?.type === 'message' && Array.isArray( item.content ) ) {
        for ( const part of item.content ) {
          if ( part?.type === 'file' && part.file_id ) {
            fileIds.add( part.file_id );
          }
        }
      }
    }
  }

  if ( skillIds.size === 0 && fileIds.size === 0 ) return;

  // ── 3. Resolve skills and inject as system context ─────
  if ( skillIds.size > 0 ) {
    const skillParts: string[] = [];
    for ( const skillId of skillIds ) {
      const content = await resolveSkillContent( skillId );
      if ( content ) {
        skillParts.push( `[Skill: ${skillId}]\n${content}` );
      }
    }

    if ( skillParts.length > 0 ) {
      const skillBlock = `## Skills Context\nThe following skills have been loaded and are available for use:\n\n${skillParts.join( '\n\n---\n\n' )}`;

      // Find or create system message in the messages array
      if ( Array.isArray( body.messages ) ) {
        const systemMsg = body.messages.find( ( m: any ) => m.role === 'system' );
        if ( systemMsg ) {
          systemMsg.content = `${skillBlock}\n\n---\n\n${systemMsg.content}`;
        } else {
          body.messages.unshift( { role: 'system', content: skillBlock } );
        }
      }

      // Also handle `instructions` field (Responses API)
      if ( typeof body.instructions === 'string' ) {
        body.instructions = `${skillBlock}\n\n---\n\n${body.instructions}`;
      } else if ( !body.messages?.length && !body.instructions ) {
        body.instructions = skillBlock;
      }
    }

    // Strip skill tools from the tools array (upstream does not support them)
    if ( Array.isArray( body.tools ) ) {
      body.tools = body.tools.filter( ( tool: any ) => {
        if ( tool?.type === 'skill' ) return false;
        if ( tool?.type === 'function' && typeof tool.function?.name === 'string' && tool.function.name.startsWith( 'skill:' ) ) return false;
        return true;
      } );
      if ( body.tools.length === 0 ) {
        delete body.tools;
      }
    }
  }

  // ── 4. Resolve files and inject inline ────────────────
  if ( fileIds.size > 0 ) {
    const fileCache = new Map<string, string>();
    for ( const fileId of fileIds ) {
      const resolved = await resolveFileText( fileId );
      if ( resolved ) {
        fileCache.set( fileId, resolved.text );
      }
    }

    if ( fileCache.size === 0 ) return;

    // Replace file parts in messages
    if ( Array.isArray( body.messages ) ) {
      for ( const msg of body.messages ) {
        if ( !Array.isArray( msg.content ) ) continue;
        for ( let i = msg.content.length - 1; i >= 0; i-- ) {
          const part = msg.content[i];
          if ( part?.type === 'file' && part.file_id && fileCache.has( part.file_id ) ) {
            msg.content[i] = {
              type: 'text',
              text: `[File: ${part.file_id}]\n${fileCache.get( part.file_id )}`,
            };
          }
        }
      }
    }

    // Replace file parts in Responses API input
    if ( Array.isArray( body.input ) ) {
      for ( const item of body.input ) {
        if ( item?.type === 'message' && Array.isArray( item.content ) ) {
          for ( let i = item.content.length - 1; i >= 0; i-- ) {
            const part = item.content[i];
            if ( part?.type === 'file' && part.file_id && fileCache.has( part.file_id ) ) {
              item.content[i] = {
                type: 'input_text',
                text: `[File: ${part.file_id}]\n${fileCache.get( part.file_id )}`,
              };
            }
          }
        }
      }
    }
  }
}
