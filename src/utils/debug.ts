const DEBUG_VALUES = new Set( ['1', 'true', 'yes', 'on'] );

export function isDebugEnabled(): boolean {
    const raw = process.env.AI_EDGE_DEBUG?.trim().toLowerCase();
    return raw ? DEBUG_VALUES.has( raw ) : false;
}

export function redactForLog( value: unknown ): unknown {
    return redactValue( value, new Set( ['apikey', 'api_key', 'authorization', 'x-api-key'] ) );
}

function redactValue( value: unknown, keys: Set<string> ): unknown {
    if ( value == null ) {
        return value;
    }

    if ( Array.isArray( value ) ) {
        return value.map( ( item ) => redactValue( item, keys ) );
    }

    if ( typeof value === 'object' ) {
        const record = value as Record<string, unknown>;
        const output: Record<string, unknown> = {};
        for ( const [key, entry] of Object.entries( record ) ) {
            if ( keys.has( key.toLowerCase() ) ) {
                output[key] = '[redacted]';
            } else {
                output[key] = redactValue( entry, keys );
            }
        }
        return output;
    }

    return value;
}
