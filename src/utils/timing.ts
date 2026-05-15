export function formatTimingEntries( entries: Record<string, number | null | undefined> ): string {
    return Object.entries( entries )
        .filter( ( [, value] ) => typeof value === 'number' && Number.isFinite( value ) )
        .map( ( [name, value] ) => `${name};dur=${Math.max( 0, Math.round( value as number ) )}` )
        .join( ', ' );
}