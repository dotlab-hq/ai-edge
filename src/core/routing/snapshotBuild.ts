import { stripFreeModifier } from '@/utils/modelIds';

import type {
    OpenAIModelConfig,
    OpenAIModelEntry,
    RoutingEndpoint,
    RoutingEndpointCapabilities,
} from './snapshotTypes';
import { SUPPORTED_ENDPOINTS } from './snapshotTypes';

export function uniqueModelNames( models: OpenAIModelConfig['models'] ): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for ( const model of models ) {
        const name = typeof model === 'string' ? model : model.model;
        if ( !name || seen.has( name ) ) {
            continue;
        }
        seen.add( name );
        names.push( name );
    }
    return names;
}

export function uniqueNormalizedIds( modelNames: readonly string[] ): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for ( const modelName of modelNames ) {
        const normalizedId = stripFreeModifier( modelName ).normalizedId;
        if ( !normalizedId || seen.has( normalizedId ) ) {
            continue;
        }
        seen.add( normalizedId );
        normalized.push( normalizedId );
    }
    return normalized;
}

export function computeEndpointCapabilities( config: OpenAIModelConfig ): RoutingEndpointCapabilities {
    const embeddingsEnabled = config.embeddings === true;
    const imageModels = config.imageModels;
    const imageGenerationEnabled = typeof imageModels === 'object' && imageModels?.image_generation === true;
    const imageEditingEnabled = typeof imageModels === 'object' && imageModels?.image_editing === true;
    // Any image endpoint flag means this provider is image-only for routing purposes.
    const imageOnly = typeof imageModels === 'boolean'
        ? imageModels
        : imageGenerationEnabled || imageEditingEnabled;
    const sttOrTts = config.stt === true || config.tts === true;
    const textEndpointsEnabled = !embeddingsEnabled && !imageOnly && !sttOrTts;

    return Object.freeze( {
        'chat/completions': textEndpointsEnabled,
        completions: textEndpointsEnabled,
        responses: textEndpointsEnabled,
        messages: textEndpointsEnabled,
        embeddings: embeddingsEnabled,
        'images/generations': imageGenerationEnabled,
        'images/edits': imageEditingEnabled,
    } );
}

export function cloneOpenAIModelConfig( config: OpenAIModelConfig ): OpenAIModelConfig {
    const models = config.models.map( ( model ): OpenAIModelEntry => {
        if ( typeof model === 'string' ) {
            return model;
        }
        return {
            ...model,
            rateLimit: { ...model.rateLimit },
            reasoning_efforts: Array.isArray( model.reasoning_efforts ) ? [...model.reasoning_efforts] : undefined,
        };
    } ) as OpenAIModelConfig['models'];

    const imageModels = typeof config.imageModels === 'object' && config.imageModels
        ? { ...config.imageModels }
        : config.imageModels;

    return {
        ...config,
        models,
        imageModels,
        rateLimit: config.rateLimit ? { ...config.rateLimit } : undefined,
        reasoning_efforts: Array.isArray( config.reasoning_efforts ) ? [...config.reasoning_efforts] : undefined,
    };
}

export function normalizeStartIndex( startIndex: number | undefined, total: number, fallback: () => number ): number {
    if ( total <= 0 ) {
        return 0;
    }
    if ( typeof startIndex === 'number' && Number.isFinite( startIndex ) ) {
        const normalized = Math.floor( startIndex ) % total;
        return normalized >= 0 ? normalized : normalized + total;
    }
    return fallback();
}

export function rotateList<T>( items: readonly T[], startIndex: number ): T[] {
    if ( !items.length || startIndex <= 0 ) {
        return items.slice();
    }
    return [...items.slice( startIndex ), ...items.slice( 0, startIndex )];
}

export { SUPPORTED_ENDPOINTS };
export type { RoutingEndpoint };
