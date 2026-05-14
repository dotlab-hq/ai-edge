export type NormalizedModelId = {
    normalizedId: string;
    isFree: boolean;
};

const FREE_PREFIX = 'free:';
const FREE_SUFFIX = ':free';

export function stripFreeModifier( modelId: string ): NormalizedModelId {
    const trimmed = ( modelId ?? '' ).trim();
    let normalizedId = trimmed;
    let isFree = false;

    if ( normalizedId.startsWith( FREE_PREFIX ) ) {
        normalizedId = normalizedId.slice( FREE_PREFIX.length );
        isFree = true;
    }

    if ( normalizedId.endsWith( FREE_SUFFIX ) ) {
        normalizedId = normalizedId.slice( 0, -FREE_SUFFIX.length );
        isFree = true;
    }

    return { normalizedId, isFree };
}
