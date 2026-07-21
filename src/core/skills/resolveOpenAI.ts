/**
 * OpenAI-format request body resolver.
 *
 * Resolves file and skill references in an OpenAI-format request body:
 *   - {type: "file", file_id} in message content parts
 *   - {type: "skill", skill_id} / {type: "function", name: "skill:..."} tools
 *   - Responses API input items
 */
import {
  isSkillResolverReady,
  resolveSkillContent,
  resolveFileBinary,
} from './resolver';

/**
 * Resolve all file and skill references in an OpenAI-format request body.
 * Mutates `body` in place.
 */
export async function resolveOpenAIBody( body: any ): Promise<void> {
  if ( !isSkillResolverReady() || !body ) return;

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
    const fileCache = new Map<string, { text: string; mimeType: string }>();
    for ( const fileId of fileIds ) {
      // Use resolveFileBinary so we can check MIME type before decoding
      const binary = await resolveFileBinary( fileId );
      if ( binary ) {
        const mimeType = binary.mimeType.toLowerCase();
        // PDFs and other binary files cannot be decoded as UTF-8 text
        if ( mimeType === 'application/pdf' ) {
          fileCache.set( fileId, { text: `[PDF attachment: ${binary.filename} — this provider does not support PDF input via chat completions. Try uploading the file via the Files API or using the Responses API.]`, mimeType } );
        } else if ( mimeType.startsWith( 'text/' ) || mimeType === 'application/json' || mimeType === 'application/xml' ) {
          fileCache.set( fileId, { text: binary.body.toString( 'utf-8' ), mimeType } );
        } else {
          // Other binary files — inject a placeholder
          fileCache.set( fileId, { text: `[File: ${binary.filename} (${mimeType}) — binary content not supported via chat completions]`, mimeType } );
        }
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
              text: `[File: ${part.file_id}]\n${fileCache.get( part.file_id )!.text}`,
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
                text: `[File: ${part.file_id}]\n${fileCache.get( part.file_id )!.text}`,
              };
            }
          }
        }
      }
    }
  }
}
