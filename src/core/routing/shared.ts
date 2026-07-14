import { stripFreeModifier } from '@/utils/modelIds';

type AnyProviderConfig = any;

export function isAutoModel( modelName: string ): boolean {
    return stripFreeModifier( modelName ).normalizedId === 'auto';
}

export function configHasModel( config: AnyProviderConfig, modelName: string ): boolean {
    const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
    return config.models.some( ( m: any ) => {
        const candidate = typeof m === 'string' ? m : m.model;
        return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );
}

export function isEmbeddingsEnabled( config: AnyProviderConfig ): boolean {
    return config.embeddings === true;
}

export function isGeminiProvider( config: AnyProviderConfig ): boolean {
    const baseUrl = ( config.baseUrl || '' ).toLowerCase();
    const id = ( config.id || '' ).toLowerCase();
    const name = ( config.name || '' ).toLowerCase();
    return baseUrl.includes( 'gemini' ) || baseUrl.includes( 'google' )
        || id.includes( 'gemini' ) || id.includes( 'google' )
        || name.includes( 'gemini' ) || name.includes( 'google' );
}
