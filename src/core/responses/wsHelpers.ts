import type { WSConnection } from './wsTypes';
import { MAX_INPUT_CHARS_BEFORE_COMPACT, MAX_CONTEXT_MESSAGES } from './wsTypes';

export function generateResponseId(): string {
    const ts = Date.now().toString( 36 );
    const rand = Math.random().toString( 36 ).substring( 2, 8 );
    return `resp_${ts}${rand}`;
}

export function generateWsId( prefix: string ): string {
    const ts = Date.now().toString( 36 );
    const seq = Math.random().toString( 36 ).substring( 2, 8 );
    return `${prefix}_${ts}${seq}`;
}

export function normaliseInput( input: any ): any[] {
    if ( input == null ) return [];
    if ( typeof input === 'string' ) return [ { role: 'user', content: input } ];
    if ( Array.isArray( input ) ) return input;
    return [];
}

export function trimResponseCache( conn: WSConnection ): void {
    if ( conn.responseCache.size <= 100 ) return;
    const keys = Array.from( conn.responseCache.keys() );
    for ( let i = 0; i < keys.length - 50; i++ ) {
        conn.responseCache.delete( keys[i]! );
    }
}

export function shouldCompressContext( inputItems: any[] ): boolean {
    let totalChars = 0;
    for ( const item of inputItems ) {
        totalChars += estimateItemChars( item );
        if ( totalChars > MAX_INPUT_CHARS_BEFORE_COMPACT ) {
            return true;
        }
    }
    return false;
}

export function compressContext( inputItems: any[] ): { compressed: any[]; dropped: number } {
    const systemItems: any[] = [];
    const otherItems: any[] = [];
    for ( const item of inputItems ) {
        const role = ( item.role as string ) || '';
        if ( role === 'system' || role === 'developer' ) {
            systemItems.push( item );
        } else {
            otherItems.push( item );
        }
    }

    if ( otherItems.length > MAX_CONTEXT_MESSAGES ) {
        const kept = otherItems.slice( otherItems.length - MAX_CONTEXT_MESSAGES );
        return {
            compressed: [ ...systemItems, ...kept ],
            dropped: otherItems.length - MAX_CONTEXT_MESSAGES,
        };
    }

    return { compressed: inputItems, dropped: 0 };
}

function estimateItemChars( item: any ): number {
    if ( !item || typeof item !== 'object' ) return 0;
    try {
        return JSON.stringify( item ).length;
    } catch {
        return 0;
    }
}

export async function safeParseJson( res: Response ): Promise<any> {
    try {
        const ct = res.headers.get( 'content-type' ) ?? '';
        if ( ct.includes( 'application/json' ) ) {
            return await res.json();
        }
        const text = await res.text();
        return text ? JSON.parse( text ) : null;
    } catch {
        return null;
    }
}
