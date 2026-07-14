import { stripFreeModifier } from '@/utils/modelIds';

import {
    AUTO_MODEL_ID,
    SUPPORTED_ENDPOINTS,
    type CompiledRoutingProvider,
    type OpenAIModelConfig,
    type RoutingCandidateModelOptions,
    type RoutingEndpoint,
    type RoutingEndpointCapabilities,
    type RoutingPoolOptions,
    type RoutingProviderPool,
    type RoutingProviderSnapshot,
    type RoutingSnapshotConfigResolver,
} from './routing/snapshotTypes';
import {
    cloneOpenAIModelConfig,
    computeEndpointCapabilities,
    normalizeStartIndex,
    rotateList,
    uniqueModelNames,
    uniqueNormalizedIds,
} from './routing/snapshotBuild';

export type { RoutingEndpoint, RoutingEndpointCapabilities, RoutingProviderSnapshot, RoutingPoolOptions, RoutingCandidateModelOptions, RoutingProviderPool } from './routing/snapshotTypes';

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
        const explicitlyAuto = normalizedRequestedModel === AUTO_MODEL_ID;
        const includeFallback = options.includeFallback !== false;
        const honorRandomRouting = options.honorRandomRouting !== false;

        const endpointProviders = this.providersByEndpoint.get( endpoint ) ?? [];
        const modelLookup = this.providersByEndpointAndModel.get( endpoint );
        const exactProviders = modelLookup?.get( normalizedRequestedModel ) ?? [];
        const exactIds = new Set( exactProviders.map( provider => provider.id ) );

        const modelIsListed = exactProviders.length > 0;
        const isAutoModel = explicitlyAuto || !modelIsListed;

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
        const explicitlyAuto = requestedNormalized === AUTO_MODEL_ID;
        const honorRandomRouting = options.honorRandomRouting !== false;
        const randomize = options.randomize !== false;

        const modelInThisProvider = provider.normalizedModelSet.has( requestedNormalized );
        const isAutoModel = explicitlyAuto || !modelInThisProvider;

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

export type { RoutingSnapshotConfigResolver } from './routing/snapshotTypes';

export {
    RoutingSnapshotStore,
    buildRoutingSnapshotFromConfig,
} from './routing/snapshotStore';
