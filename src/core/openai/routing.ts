import { stripFreeModifier } from '@/utils/modelIds';
import { CONFIG } from '@/utils/schema.lookup';
import { FAST_MODEL_HINTS } from './types';
import type { BackendState, OpenAIModelConfig } from './types';
import { isAutoModel, configHasModel, isEmbeddingsEnabled, isGeminiProvider } from '../routing/shared';

export { isAutoModel, configHasModel, isEmbeddingsEnabled, isGeminiProvider };

const MAX_CACHE_SIZE = 1000;
const BACKEND_CACHE_TTL_MS = 30_000;

export function isSttEnabled( config: OpenAIModelConfig ): boolean {
    return config.stt === true;
}

export function isTtsEnabled( config: OpenAIModelConfig ): boolean {
    return config.tts === true;
}

export function isImageGenerationEnabled( config: OpenAIModelConfig ): boolean {
    const imageModels = config.imageModels;
    return typeof imageModels === 'object' && imageModels?.image_generation === true;
}

export function isImageEditingEnabled( config: OpenAIModelConfig ): boolean {
    const imageModels = config.imageModels;
    return typeof imageModels === 'object' && imageModels?.image_editing === true;
}

export function isImageOnlyConfig( config: OpenAIModelConfig ): boolean {
    const imageModels = config.imageModels;
    if ( typeof imageModels === 'boolean' ) return imageModels;
    return imageModels?.image_generation === true || imageModels?.image_editing === true;
}

export function isSttOrImageOnlyConfig( config: OpenAIModelConfig ): boolean {
    return isSttEnabled( config ) || isTtsEnabled( config ) || isImageOnlyConfig( config );
}

export function getBackendsForModel(
    state: BackendState,
    modelName: string,
    endpoint?: string,
): OpenAIModelConfig[] {
    const cacheKey = `${modelName}|${endpoint ?? ''}`;
    const cached = state.backendRouteCache.get( cacheKey );
    if ( cached ) return cached;

    const configs = CONFIG.models.openai ?? [];
    const explicitlyAuto = isAutoModel( modelName );
    const modelIsListed = configs.some( config => configHasModel( config, modelName ) );
    const isAutoModelFlag = explicitlyAuto || !modelIsListed;

    const exactBackends: OpenAIModelConfig[] = [];
    const fallbackBackends: OpenAIModelConfig[] = [];

    for ( const config of configs ) {
        const matchesRequestedModel = configHasModel( config, modelName );
        const canRouteWithoutModelMatch = ( isAutoModelFlag || config.randomRouting !== false ) && !matchesRequestedModel;

        if ( endpoint === 'embeddings' ) {
            if ( !isEmbeddingsEnabled( config ) ) continue;
        } else if ( endpoint === 'audio/transcriptions' || endpoint === 'audio/translations' ) {
            if ( !isSttEnabled( config ) ) continue;
        } else if ( endpoint === 'audio/speech' ) {
            if ( !isTtsEnabled( config ) ) continue;
        } else if ( endpoint === 'images/generations' ) {
            if ( !isImageGenerationEnabled( config ) ) continue;
        } else if ( endpoint === 'images/edits' ) {
            if ( !isImageEditingEnabled( config ) ) continue;
        } else if ( endpoint === 'chat/completions' || endpoint === 'completions' || endpoint === 'responses' ) {
            if ( isSttOrImageOnlyConfig( config ) || isEmbeddingsEnabled( config ) ) continue;
        }

        if ( matchesRequestedModel ) {
            exactBackends.push( config );
        } else if ( canRouteWithoutModelMatch ) {
            fallbackBackends.push( config );
        }
    }

    const result = isAutoModelFlag
        ? fallbackBackends
        : modelIsListed ? [...exactBackends, ...fallbackBackends] : fallbackBackends;

    if ( state.backendRouteCache.size > MAX_CACHE_SIZE ) {
        const firstKey = state.backendRouteCache.keys().next().value;
        if ( firstKey ) state.backendRouteCache.delete( firstKey );
    }
    state.backendRouteCache.set( cacheKey, result );
    return result;
}

function getAndIncrementRoundRobinIndex( state: BackendState, key: string, total: number ): number {
    if ( total <= 0 ) return 0;

    if ( state.rrIndexByKey.size > MAX_CACHE_SIZE ) {
        const keys = Array.from( state.rrIndexByKey.keys() );
        const randomKey = keys[ Math.floor( Math.random() * keys.length ) ];
        state.rrIndexByKey.delete( randomKey! );
    }

    const current = state.rrIndexByKey.get( key ) ?? 0;
    const index = current % total;
    state.rrIndexByKey.set( key, ( index + 1 ) % total );
    return index;
}

export function getRoundRobinBackends( state: BackendState, modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
    if ( backends.length <= 1 ) return backends;

    const key = `model:${modelName}`;
    const startIndex = getAndIncrementRoundRobinIndex( state, key, backends.length );
    return [ ...backends.slice( startIndex ), ...backends.slice( 0, startIndex ) ];
}

export function getOptimizedBackends(
    state: BackendState,
    modelName: string,
    endpoint: string | undefined,
    backends: OpenAIModelConfig[],
): OpenAIModelConfig[] {
    if ( backends.length <= 1 ) return backends;

    const cacheKey = `${endpoint ?? 'default'}:${modelName}`;
    const cached = state.optimizedBackendCache.get( cacheKey );
    if ( cached && cached.expiresAt > Date.now() ) return cached.backends;

    const rotated = getRoundRobinBackends( state, cacheKey, backends );
    const sorted = rotated.sort( ( left, right ) =>
        scoreProvider( state, right, modelName ) - scoreProvider( state, left, modelName )
    );

    state.optimizedBackendCache.set( cacheKey, {
        backends: sorted,
        expiresAt: Date.now() + BACKEND_CACHE_TTL_MS,
    } );

    if ( state.optimizedBackendCache.size > MAX_CACHE_SIZE ) {
        const firstKey = state.optimizedBackendCache.keys().next().value;
        if ( firstKey ) state.optimizedBackendCache.delete( firstKey );
    }

    return sorted;
}

export function scoreProvider( state: BackendState, config: OpenAIModelConfig, requestedModel: string ): number {
    const candidateModels = getCandidateModelsForProvider( state, config, requestedModel );
    const firstModel = candidateModels[0] ?? requestedModel;
    const stats = state.providerStats.getStats( config.id, firstModel );
    const latencyScore = stats?.latencyEwmaMs ? Math.max( 0, 1 - stats.latencyEwmaMs / 30_000 ) : 0.5;
    const successScore = stats?.successRateEwma ?? 1;
    const exactScore = configHasModel( config, requestedModel ) ? 1 : 0;
    return exactScore * 100 + successScore * 10 + latencyScore + scoreModelSpeedHint( firstModel ) - ( stats?.consecutiveFailures ?? 0 );
}

export function getCandidateModelsForProvider( state: BackendState, config: OpenAIModelConfig, requestedModel: string ): string[] {
    const explicitlyAuto = isAutoModel( requestedModel );
    const modelInThisProvider = config.models.some( m => {
        const candidate = typeof m === 'string' ? m : ( m as any ).model;
        return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( requestedModel ).normalizedId;
    } );
    const isAutoModelFlag = explicitlyAuto || !modelInThisProvider;

    if ( config.randomRouting === false && !isAutoModelFlag ) return [requestedModel];

    const modelNames = config.models.map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
    if ( !isAutoModelFlag ) return [requestedModel];
    const uniqueModels = Array.from( new Set( modelNames ) );
    if ( !uniqueModels.length ) return [requestedModel];

    return uniqueModels.sort( ( left, right ) =>
        scoreModelForProvider( state, config, right ) - scoreModelForProvider( state, config, left )
    );
}

function scoreModelForProvider( state: BackendState, config: OpenAIModelConfig, modelName: string ): number {
    const stats = state.providerStats.getStats( config.id, modelName );
    const latencyScore = stats?.latencyEwmaMs ? Math.max( 0, 1 - stats.latencyEwmaMs / 30_000 ) : 0.5;
    const successScore = stats?.successRateEwma ?? 1;
    return successScore * 10 + latencyScore + scoreModelSpeedHint( modelName ) - ( stats?.consecutiveFailures ?? 0 );
}

export function scoreModelSpeedHint( modelName: string ): number {
    const normalized = stripFreeModifier( modelName ).normalizedId.toLowerCase();
    let score = 0;
    if ( normalized.includes( 'flash-lite' ) || normalized.includes( 'lite' ) ) score += 2;
    else if ( FAST_MODEL_HINTS.some( hint => normalized.includes( hint ) ) ) score += 1;
    if ( normalized.includes( 'preview' ) ) score -= 0.25;
    return score;
}
