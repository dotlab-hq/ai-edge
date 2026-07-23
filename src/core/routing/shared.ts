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

export function isImageGenerationEnabled( config: AnyProviderConfig ): boolean {
    const imageModels = config.imageModels;
    return typeof imageModels === 'object' && imageModels?.image_generation === true;
}

export function isImageEditingEnabled( config: AnyProviderConfig ): boolean {
    const imageModels = config.imageModels;
    return typeof imageModels === 'object' && imageModels?.image_editing === true;
}

/** Providers with image_generation and/or image_editing must not serve text chat. */
export function isImageOnlyConfig( config: AnyProviderConfig ): boolean {
    const imageModels = config.imageModels;
    if ( typeof imageModels === 'boolean' ) {
        return imageModels;
    }
    return isImageGenerationEnabled( config ) || isImageEditingEnabled( config );
}

export function isSttEnabled( config: AnyProviderConfig ): boolean {
    return config.stt === true;
}

export function isTtsEnabled( config: AnyProviderConfig ): boolean {
    return config.tts === true;
}

export function isNonTextSpecializedConfig( config: AnyProviderConfig ): boolean {
    return isSttEnabled( config )
        || isTtsEnabled( config )
        || isEmbeddingsEnabled( config )
        || isImageOnlyConfig( config );
}

export function isGeminiProvider( config: AnyProviderConfig ): boolean {
    return config.extra?.isGemini === true;
}


