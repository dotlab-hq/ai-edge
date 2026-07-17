import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createGuard, type ChatGuard } from '@nationaldesignstudio/rampart';

const packageModelPath = resolve( dirname( fileURLToPath( import.meta.url ) ), '..', 'models', 'rampart' );
const workingDirectoryModelPath = resolve( process.cwd(), 'models', 'rampart' );
export const RAMPART_MODEL_PATH = existsSync( packageModelPath ) ? packageModelPath : workingDirectoryModelPath;

const RAMPART_SYSTEM_INSTRUCTION = 'PII handling instruction: bracketed tokens such as [GIVEN_NAME_1], [EMAIL_1], [SSN_1], and [CREDIT_CARD_1] are safe local aliases for private values. Treat them as ordinary data, follow the user request, and preserve these tokens exactly when referring to the corresponding values. Do not refuse, redact, warn about, or debate the tokens solely because they represent PII.';

let rampartGuardPromise: Promise<ChatGuard> | null = null;

export async function createRampartGuard( enabled: boolean ): Promise<ChatGuard | null> {
  // Rampart loads an ONNX model into native memory. Cache the guard so the
  // model is initialized once and reused by all requests.
  const globallyDisabled = /^(1|true|yes)$/i.test( process.env.AI_EDGE_DISABLE_RAMPART?.trim() ?? '' );
  if ( !enabled || globallyDisabled ) return null;
  rampartGuardPromise ??= createGuard( { device: 'cpu', model: RAMPART_MODEL_PATH } );
  return rampartGuardPromise;
}

export async function transformRampartValue( value: any, guard: ChatGuard, reveal: boolean ): Promise<any> {
  if ( typeof value === 'string' ) {
    return reveal ? guard.reveal( value ) : ( await guard.protect( value ) ).text;
  }
  if ( Array.isArray( value ) ) {
    return Promise.all( value.map( item => transformRampartValue( item, guard, reveal ) ) );
  }
  if ( value && typeof value === 'object' ) {
    const entries = await Promise.all( Object.entries( value ).map( async ( [key, item] ) => [key, await transformRampartValue( item, guard, reveal )] as const ) );
    return Object.fromEntries( entries );
  }
  return value;
}

export function addRampartInstruction( body: any ): any {
  if ( Array.isArray( body?.messages ) ) {
    const messages = body.messages.slice();
    const systemIndex = messages.findIndex( ( message: any ) => message?.role === 'system' );
    if ( systemIndex >= 0 ) {
      const system = messages[systemIndex];
      messages[systemIndex] = { ...system, content: `${RAMPART_SYSTEM_INSTRUCTION}\n\n${typeof system.content === 'string' ? system.content : JSON.stringify( system.content )}` };
    } else {
      messages.unshift( { role: 'system', content: RAMPART_SYSTEM_INSTRUCTION } );
    }
    return { ...body, messages };
  }
  return typeof body?.prompt === 'string'
    ? { ...body, prompt: `${RAMPART_SYSTEM_INSTRUCTION}\n\n${body.prompt}` }
    : body;
}
