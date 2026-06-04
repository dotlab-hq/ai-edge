/**
 * State-machine parser that detects `` tags in streaming
 * text content and segments the output into thinking vs normal-text portions.
 *
 * Handles tags that span chunk boundaries by buffering tail characters.
 */

const TAGS = [
    { open: '', close: '' },
    { open: '', close: '' },
];

function tagPrefixes(): string[] {
    const out: string[] = [];
    for ( const t of TAGS ) {
        for ( let i = 1; i <= t.open.length; i++ ) out.push( t.open.slice( 0, i ) );
        for ( let i = 1; i <= t.close.length; i++ ) out.push( t.close.slice( 0, i ) );
    }
    return out;
}

const KNOWN_PREFIXES = tagPrefixes();
const MAX_TAG_LEN = Math.max( ...TAGS.map( t => Math.max( t.open.length, t.close.length ) ) );

export interface ThinkingSegment {
    type: 'thinking' | 'text';
    content: string;
}

export class ThinkingTagParser {
    private inThinking = false;
    private buffer = '';

    /**
     * Feed streaming content and receive segmented output.
     * Partial tags at the end of the buffer are held back until more data arrives.
     */
    process( content: string ): ThinkingSegment[] {
        this.buffer += content;
        const segments: ThinkingSegment[] = [];

        while ( true ) {
            if ( this.inThinking ) {
                // Look for any closing tag
                let earliest = -1;
                let matchedClose = '';
                for ( const t of TAGS ) {
                    const idx = this.buffer.indexOf( t.close );
                    if ( idx !== -1 && ( earliest === -1 || idx < earliest ) ) {
                        earliest = idx;
                        matchedClose = t.close;
                    }
                }

                if ( earliest === -1 ) {
                    // No full close tag found — emit everything except a tail that
                    // could be a partial close tag.
                    const safeEnd = this.findSafeEnd( this.buffer );
                    if ( safeEnd > 0 ) {
                        segments.push( { type: 'thinking', content: this.buffer.slice( 0, safeEnd ) } );
                    }
                    this.buffer = this.buffer.slice( safeEnd );
                    break;
                }

                if ( earliest > 0 ) {
                    segments.push( { type: 'thinking', content: this.buffer.slice( 0, earliest ) } );
                }
                this.buffer = this.buffer.slice( earliest + matchedClose.length );
                this.inThinking = false;
            } else {
                // Look for any opening tag
                let earliest = -1;
                let matchedOpen = '';
                for ( const t of TAGS ) {
                    const idx = this.buffer.indexOf( t.open );
                    if ( idx !== -1 && ( earliest === -1 || idx < earliest ) ) {
                        earliest = idx;
                        matchedOpen = t.open;
                    }
                }

                if ( earliest === -1 ) {
                    // No full open tag found — emit except a partial-open tail.
                    const safeEnd = this.findSafeEnd( this.buffer );
                    if ( safeEnd > 0 ) {
                        segments.push( { type: 'text', content: this.buffer.slice( 0, safeEnd ) } );
                    }
                    this.buffer = this.buffer.slice( safeEnd );
                    break;
                }

                if ( earliest > 0 ) {
                    segments.push( { type: 'text', content: this.buffer.slice( 0, earliest ) } );
                }
                this.buffer = this.buffer.slice( earliest + matchedOpen.length );
                this.inThinking = true;
            }
        }

        return segments;
    }

    /**
     * Flush any remaining buffered content at stream end.
     */
    flush(): ThinkingSegment[] {
        if ( !this.buffer ) return [];
        const segments: ThinkingSegment[] = [
            { type: this.inThinking ? 'thinking' : 'text', content: this.buffer },
        ];
        this.buffer = '';
        return segments;
    }

    /**
     * Find how many characters at the end of `str` could be the start of a tag.
     * Returns the number of safe (non-partial) characters.
     */
    private findSafeEnd( str: string ): number {
        const maxCheck = Math.min( MAX_TAG_LEN - 1, str.length );
        for ( let len = maxCheck; len >= 1; len-- ) {
            const tail = str.slice( str.length - len );
            for ( const prefix of KNOWN_PREFIXES ) {
                if ( prefix.startsWith( tail ) ) {
                    return str.length - len;
                }
            }
        }
        return str.length;
    }
}
