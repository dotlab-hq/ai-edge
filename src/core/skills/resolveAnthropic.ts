/**
 * Anthropic-format request body resolver.
 *
 * Resolves file and skill references in an Anthropic-format request body:
 *   - {type: "document", source: {type: "file", file_id}}
 *   - {type: "image", source: {type: "file", file_id}}
 *   - {type: "container_upload", file_id}
 *   - body.container.skills: [{type, skill_id, version}]
 */
import {
  isSkillResolverReady,
  isImageMime,
  resolveSkillContent,
  resolveFileBase64,
  resolveFileText,
} from './resolver';

/**
 * Resolve all file and skill references in an Anthropic-format request body.
 * Mutates `body` in place.
 */
export async function resolveAnthropicBody( body: any ): Promise<void> {
  if ( !isSkillResolverReady() || !body ) return;

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
    console.log( `[SkillResolver] resolving ${fileIds.size} file(s): ${Array.from( fileIds ).join( ', ' )}` );
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
        console.log( `[SkillResolver] file ${fileId} resolved → ${base64.media_type} (${base64.data.length} chars base64)` );
      } else {
        console.error( `[SkillResolver] file ${fileId} FAILED to resolve` );
      }
    }

    if ( fileCache.size === 0 ) {
      console.error( `[SkillResolver] all file resolutions failed — injecting fallback text blocks` );
      // Replace unresolved file references with text fallbacks so the model gets content
      for ( const msg of body.messages ) {
        if ( !Array.isArray( msg.content ) ) continue;
        for ( let i = msg.content.length - 1; i >= 0; i-- ) {
          const block = msg.content[i];
          if ( block?.type === 'document' && block.source?.type === 'file' && block.source?.file_id ) {
            msg.content[i] = { type: 'text', text: `[File ${block.source.file_id} could not be resolved]` };
          }
          if ( block?.type === 'image' && block.source?.type === 'file' && block.source?.file_id ) {
            msg.content[i] = { type: 'text', text: `[Image ${block.source.file_id} could not be resolved]` };
          }
          if ( block?.type === 'container_upload' && block.file_id ) {
            msg.content[i] = { type: 'text', text: `[File ${block.file_id} could not be resolved]` };
          }
        }
      }
      return;
    }

    // Replace file reference blocks in messages
    for ( const msg of body.messages ) {
      if ( !Array.isArray( msg.content ) ) continue;
      for ( let i = msg.content.length - 1; i >= 0; i-- ) {
        const block = msg.content[i];

        // Document block with file source → replace source with base64 or fallback
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
          } else {
            msg.content[i] = { type: 'text', text: `[File ${block.source.file_id} could not be resolved]` };
          }
        }

        // Image block with file source → replace source with base64 or fallback
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
          } else {
            msg.content[i] = { type: 'text', text: `[Image ${block.source.file_id} could not be resolved]` };
          }
        }

        // Container upload block → replace with document, image, or fallback
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
          } else {
            msg.content[i] = { type: 'text', text: `[File ${block.file_id} could not be resolved]` };
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
              } else {
                block.content[j] = { type: 'text', text: `[File ${subBlock.source.file_id} could not be resolved]` };
              }
            }
            if ( subBlock?.type === 'image' && subBlock.source?.type === 'file' && subBlock.source?.file_id ) {
              const cached = fileCache.get( subBlock.source.file_id );
              if ( cached ) {
                block.content[j] = {
                  type: 'image',
                  source: { type: 'base64', media_type: cached.media_type, data: cached.data },
                };
              } else {
                block.content[j] = { type: 'text', text: `[Image ${subBlock.source.file_id} could not be resolved]` };
              }
            }
          }
        }
      }
    }
  }
}
