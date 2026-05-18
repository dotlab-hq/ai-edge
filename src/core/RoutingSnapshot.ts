import type { Config } from '@/schema';
import { stripFreeModifier } from '@/utils/modelIds';
import { CONFIG } from '@/utils/schema.lookup';

type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
type OpenAIModelEntry = OpenAIModelConfig['models'][number];

const AUTO_MODEL_ID = 'auto';

export type RoutingEndpoint =
    | 'chat/completions'
    | 'completions'
    | 'responses'
    | 'messages'
    | 'embeddings'
    | 'images/generations'
    | 'images/edits';

const SUPPORTED_ENDPOINTS: readonly RoutingEndpoint[] = [
    'chat/completions',
    'completions',
    'responses',
    'messages',
    'embeddings',
    'images/generations',
    'images/edits',
];

export type RoutingEndpointCapabilities = Readonly<Record<RoutingEndpoint, boolean>>;

export type RoutingProviderSnapshot = Readonly<{
    id: string;
    index: number;
    randomRouting: boolean;
    modelNames: readonly string[];
    normalizedModelIds: readonly string[];
    capabilities: RoutingEndpointCapabilities;
    config: OpenAIModelConfig;
}>;

type CompiledRoutingProvider = RoutingProviderSnapshot & {
    readonly normalizedModelSet: ReadonlySet<string>;
};

export type RoutingPoolOptions = Readonly<{
    includeFallback?: boolean;
    honorRandomRouting?: boolean;
}>;

export type RoutingCandidateModelOptions = Readonly<{
    honorRandomRouting?: boolean;
    randomize?: boolean;
    startIndex?: number;
    random?: () => number;
}>;

export type RoutingProviderPool = Readonly<{
    endpoint: RoutingEndpoint;
    requestedModel: string;
    normalizedRequestedModel: string;
    isAutoModel: boolean;
    includeFallback: boolean;
    honorRandomRouting: boolean;
    exactProviders: readonly RoutingProviderSnapshot[];
    fallbackProviders: readonly RoutingProviderSnapshot[];
    providers: readonly RoutingProviderSnapshot[];
}>;

export class RoutingSnapshot {
    readonly compiledAt: number;
    readonly providers: readonly RoutingProviderSnapshot[];

    private readonly providerById: ReadonlyMap<string, CompiledRoutingProvider>;
    private readonly providersByEndpoint: ReadonlyMap<RoutingEndpoint, readonly CompiledRoutingProvider[]>;
    private readonly providersByEndpointAndModel: ReadonlyMap<RoutingEndpoint, ReadonlyMap<string, readonly CompiledRoutingProvider[]>>;

    private constructor( compiled: {
        providers: readonly CompiledRoutingProvider[];
        providerById: ReadonlyMap<string, CompiledRoutingProvider>;
        providersByEndpoint: ReadonlyMap<RoutingEndpoint, readonly CompiledRoutingProvider[]>;
        providersByEndpointAndModel: ReadonlyMap<RoutingEndpoint, ReadonlyMap<string, readonly CompiledRoutingProvider[]>>;
        compiledAt: number;
    } ) {
        this.compiledAt = compiled.compiledAt;
        this.providers = compiled.providers;
        this.providerById = compiled.providerById;
        this.providersByEndpoint = compiled.providersByEndpoint;
        this.providersByEndpointAndModel = compiled.providersByEndpointAndModel;
    }

    static compile( configs: ReadonlyArray<OpenAIModelConfig> = [] ): RoutingSnapshot {
        const providers: CompiledRoutingProvider[] = [];
        const providerById = new Map<string, CompiledRoutingProvider>();

        const providersByEndpoint = new Map<RoutingEndpoint, CompiledRoutingProvider[]>();
        const providersByEndpointAndModel = new Map<RoutingEndpoint, Map<string, CompiledRoutingProvider[]>>();
        for ( const endpoint of SUPPORTED_ENDPOINTS ) {
            providersByEndpoint.set( endpoint, [] );
            providersByEndpointAndModel.set( endpoint, new Map() );
        }

        for ( let index = 0; index < configs.length; index += 1 ) {
            const config = configs[index];
            if ( !config || typeof config.id !== 'string' || !config.id ) {
                continue;
            }

            const modelNames = uniqueModelNames( config.models );
            const normalizedModelIds = uniqueNormalizedIds( modelNames );
            const capabilities = computeEndpointCapabilities( config );
            const clonedConfig = cloneOpenAIModelConfig( config );
            const compiledProvider = Object.freeze( {
                id: config.id,
                index,
                randomRouting: config.randomRouting !== false,
                modelNames: Object.freeze( modelNames ),
                normalizedModelIds: Object.freeze( normalizedModelIds ),
                capabilities,
                config: clonedConfig,
                normalizedModelSet: new Set( normalizedModelIds ),
            } ) as CompiledRoutingProvider;

            providers.push( compiledProvider );
            providerById.set( compiledProvider.id, compiledProvider );

            for ( const endpoint of SUPPORTED_ENDPOINTS ) {
                if ( !compiledProvider.capabilities[endpoint] ) {
                    continue;
                }

                const endpointProviders = providersByEndpoint.get( endpoint );
                endpointProviders?.push( compiledProvider );

                const modelsByEndpoint = providersByEndpointAndModel.get( endpoint );
                if ( !modelsByEndpoint ) {
                    continue;
                }

                for ( const normalizedModelId of compiledProvider.normalizedModelIds ) {
                    const byModel = modelsByEndpoint.get( normalizedModelId ) ?? [];
                    byModel.push( compiledProvider );
                    modelsByEndpoint.set( normalizedModelId, byModel );
                }
            }
        }

        const frozenProviders = Object.freeze( providers.slice() ) as readonly CompiledRoutingProvider[];
        const frozenProviderById = new Map<string, CompiledRoutingProvider>( providerById );

        const frozenByEndpoint = new Map<RoutingEndpoint, readonly CompiledRoutingProvider[]>();
        for ( const endpoint of SUPPORTED_ENDPOINTS ) {
            const endpointProviders = providersByEndpoint.get( endpoint ) ?? [];
            frozenByEndpoint.set( endpoint, Object.freeze( endpointProviders.slice() ) );
        }

        const frozenByEndpointAndModel = new Map<RoutingEndpoint, ReadonlyMap<string, readonly CompiledRoutingProvider[]>>();
        for ( const endpoint of SUPPORTED_ENDPOINTS ) {
            const source = providersByEndpointAndModel.get( endpoint ) ?? new Map<string, CompiledRoutingProvider[]>();
            const next = new Map<string, readonly CompiledRoutingProvider[]>();
            for ( const [normalizedModelId, matchingProviders] of source.entries() ) {
                next.set( normalizedModelId, Object.freeze( matchingProviders.slice() ) );
            }
            frozenByEndpointAndModel.set( endpoint, next );
        }

        return new RoutingSnapshot( {
            providers: frozenProviders,
            providerById: frozenProviderById,
            providersByEndpoint: frozenByEndpoint,
            providersByEndpointAndModel: frozenByEndpointAndModel,
            compiledAt: Date.now(),
        } );
    }

    getProviderById( providerId: string ): RoutingProviderSnapshot | undefined {
        return this.providerById.get( providerId );
    }

    getProvidersForEndpoint( endpoint: RoutingEndpoint ): readonly RoutingProviderSnapshot[] {
        return this.providersByEndpoint.get( endpoint ) ?? [];
    }

    getProviderPool( requestedModel: string, endpoint: RoutingEndpoint, options: RoutingPoolOptions = {} ): RoutingProviderPool {
        const normalizedRequestedModel = stripFreeModifier( requestedModel ).normalizedId;
        const isAutoModel = normalizedRequestedModel === AUTO_MODEL_ID;
        const includeFallback = options.includeFallback !== false;
        const honorRandomRouting = options.honorRandomRouting !== false;

        const endpointProviders = this.providersByEndpoint.get( endpoint ) ?? [];
        const modelLookup = this.providersByEndpointAndModel.get( endpoint );
        const exactProviders = modelLookup?.get( normalizedRequestedModel ) ?? [];
        const exactIds = new Set( exactProviders.map( provider => provider.id ) );

        const fallbackProviders: CompiledRoutingProvider[] = [];
        if ( includeFallback || isAutoModel ) {
            for ( const provider of endpointProviders ) {
                if ( exactIds.has( provider.id ) ) {
                    continue;
                }
                if ( !isAutoModel && honorRandomRouting && provider.randomRouting === false ) {
                    continue;
                }
                fallbackProviders.push( provider );
            }
        }

        const providers = isAutoModel
            ? fallbackProviders
            : [...exactProviders, ...fallbackProviders];

        return Object.freeze( {
            endpoint,
            requestedModel,
            normalizedRequestedModel,
            isAutoModel,
            includeFallback,
            honorRandomRouting,
            exactProviders: Object.freeze( exactProviders.slice() ),
            fallbackProviders: Object.freeze( fallbackProviders ),
            providers: Object.freeze( providers ),
        } );
    }

    getCandidateModelsForProvider(
        providerOrId: string | RoutingProviderSnapshot,
        requestedModel: string,
        options: RoutingCandidateModelOptions = {}
    ): readonly string[] {
        const provider = this.resolveProvider( providerOrId );
        if ( !provider ) {
            return Object.freeze( [requestedModel] );
        }

        const requestedNormalized = stripFreeModifier( requestedModel ).normalizedId;
        const isAutoModel = requestedNormalized === AUTO_MODEL_ID;
        const honorRandomRouting = options.honorRandomRouting !== false;
        const randomize = options.randomize !== false;

        if ( !isAutoModel && honorRandomRouting && provider.randomRouting === false ) {
            return Object.freeze( [requestedModel] );
        }

        if ( !isAutoModel && provider.normalizedModelSet.has( requestedNormalized ) ) {
            return Object.freeze( [requestedModel] );
        }

        const availableModels = provider.modelNames;
        if ( availableModels.length === 0 ) {
            return Object.freeze( [requestedModel] );
        }

        if ( !randomize || availableModels.length <= 1 ) {
            return Object.freeze( availableModels.slice() );
        }

        const random = options.random ?? Math.random;
        const startIndex = normalizeStartIndex(
            options.startIndex,
            availableModels.length,
            () => Math.floor( random() * availableModels.length )
        );
        return Object.freeze( rotateList( availableModels, startIndex ) );
    }

    private resolveProvider( providerOrId: string | RoutingProviderSnapshot ): CompiledRoutingProvider | undefined {
        if ( typeof providerOrId === 'string' ) {
            return this.providerById.get( providerOrId );
        }
        return this.providerById.get( providerOrId.id );
    }
}

export type RoutingSnapshotConfigResolver = () => ReadonlyArray<OpenAIModelConfig> | undefined;

export class RoutingSnapshotStore {
    private snapshot: RoutingSnapshot;

    constructor(
        private readonly configResolver: RoutingSnapshotConfigResolver,
        initialSnapshot?: RoutingSnapshot
    ) {
        this.snapshot = initialSnapshot ?? RoutingSnapshot.compile( configResolver() ?? [] );
    }

    getSnapshot(): RoutingSnapshot {
        return this.snapshot;
    }

    rebuild(): RoutingSnapshot {
        const nextSnapshot = RoutingSnapshot.compile( this.configResolver() ?? [] );
        this.snapshot = nextSnapshot;
        return nextSnapshot;
    }

    replace( snapshot: RoutingSnapshot ): RoutingSnapshot {
        this.snapshot = snapshot;
        return snapshot;
    }
}

export function buildRoutingSnapshotFromConfig(
    configs: ReadonlyArray<OpenAIModelConfig> | undefined = CONFIG.models.openai ?? []
): RoutingSnapshot {
    return RoutingSnapshot.compile( configs ?? [] );
}

function uniqueModelNames( models: OpenAIModelConfig['models'] ): string[] {
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

function uniqueNormalizedIds( modelNames: readonly string[] ): string[] {
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

function computeEndpointCapabilities( config: OpenAIModelConfig ): RoutingEndpointCapabilities {
    const embeddingsEnabled = config.embeddings === true;
    const imageModels = config.imageModels;
    const imageGenerationEnabled = typeof imageModels === 'object' && imageModels?.image_generation === true;
    const imageEditingEnabled = typeof imageModels === 'object' && imageModels?.image_editing === true;
    const imageOnly = typeof imageModels === 'boolean'
        ? imageModels
        : imageGenerationEnabled || imageEditingEnabled;
    const textEndpointsEnabled = !embeddingsEnabled && !imageOnly;

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

function cloneOpenAIModelConfig( config: OpenAIModelConfig ): OpenAIModelConfig {
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

function normalizeStartIndex( startIndex: number | undefined, total: number, fallback: () => number ): number {
    if ( total <= 0 ) {
        return 0;
    }
    if ( typeof startIndex === 'number' && Number.isFinite( startIndex ) ) {
        const normalized = Math.floor( startIndex ) % total;
        return normalized >= 0 ? normalized : normalized + total;
    }
    return fallback();
}

function rotateList<T>( items: readonly T[], startIndex: number ): T[] {
    if ( !items.length || startIndex <= 0 ) {
        return items.slice();
    }
    return [...items.slice( startIndex ), ...items.slice( 0, startIndex )];
}
