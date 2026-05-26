import { fetchWithProxy } from '@/utils/proxyFetch';
import { stripFreeModifier } from '@/utils/modelIds';
import { CONFIG } from '@/utils/schema.lookup';
import type { Config } from '@/schema';

type ProviderConfig = NonNullable<Config['models']['openai']>[number];
type ConfigModelEntry = ProviderConfig['models'][number];
type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const AUTO_MODEL_ID = 'Auto-Edge';
const MODEL_CREATED_AT = Math.floor( Date.now() / 1000 );

type CatalogModel = Record<string, any>;

type ProviderCatalog = {
    providerId: string;
    providerName: string;
    baseUrl: string;
    models: CatalogModel[];
    modelIds: string[];
    lastFetchedAt: number;
    source: 'upstream' | 'config';
};

export type UnifiedModelCatalogEntry = {
    id: string;
    object: string;
    name: string;
    display_name: string;
    description: string;
    created: number;
    owned_by: 'ai-edge';
    architecture: {
        input_modalities: string[];
        output_modalities: string[];
        tokenizer: string;
    };
    top_provider: {
        is_moderated: boolean;
        context_length: number;
        max_completion_tokens: number;
    };
    context_length: number;
    supported_parameters: string[];
    capabilities: {
        reasoning: boolean;
        thinking: boolean;
        reasoning_levels: Array<Exclude<ReasoningEffort, 'none'>>;
    };
    supports_reasoning: boolean;
    reasoning: boolean;
    reasoning_effort: boolean;
    thinking: boolean;
    output_reasoning: boolean;
    opencode: {
        ai_sdk_provider: 'ai-edge';
        variants: Record<string, {
            reasoning: {
                enabled: boolean;
                effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
            };
            verbosity?: string;
        }>;
    };
    effort: Record<string, { supported: boolean } | boolean>;
    preferredIndex: number;
    isFree: boolean;
    providers: string[];
};

export type UnifiedModelCatalog = {
    data: UnifiedModelCatalogEntry[];
    byId: Record<string, UnifiedModelCatalogEntry>;
    byNormalizedId: Record<string, UnifiedModelCatalogEntry>;
    providerCatalogs: Record<string, ProviderCatalog>;
    modelIds: string[];
    lastFetchedAt: number;
};

const EMPTY_CATALOG: UnifiedModelCatalog = {
    data: [],
    byId: {},
    byNormalizedId: {},
    providerCatalogs: {},
    modelIds: [],
    lastFetchedAt: 0,
};

let cache: UnifiedModelCatalog = EMPTY_CATALOG;
let fetchInFlight: Promise<void> | null = null;

function normalizeBaseUrl( baseUrl: string ): string {
    return baseUrl.replace( /\/+$/, '' );
}

function buildModelsUrl( baseUrl: string ): string {
    return `${normalizeBaseUrl( baseUrl )}/models`;
}

const DEFAULT_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

function isModelObject( modelEntry: ConfigModelEntry | undefined ): modelEntry is Extract<ConfigModelEntry, object> {
    return typeof modelEntry === 'object' && modelEntry !== null;
}

function hasReasoningConfigured(value: { reasoning_efforts?: ReasoningEffort[]; default_reasoning?: ReasoningEffort }): boolean {
    return Object.prototype.hasOwnProperty.call(value, 'reasoning_efforts')
        || Object.prototype.hasOwnProperty.call(value, 'default_reasoning');
}

function getReasoningConfig(config: ProviderConfig, modelEntry?: ConfigModelEntry): { efforts: ReasoningEffort[]; defaultReasoning?: ReasoningEffort } {
    const source = isModelObject( modelEntry ) && ( modelEntry.reasoning_efforts || modelEntry.default_reasoning )
        ? modelEntry
        : config;
    if ( !hasReasoningConfigured( source ) ) {
        return {
            efforts: [],
            defaultReasoning: undefined,
        };
    }
    const efforts = ( source.reasoning_efforts?.length ? source.reasoning_efforts : DEFAULT_REASONING_EFFORTS ) as ReasoningEffort[];
    const defaultReasoning = source.default_reasoning as ReasoningEffort | undefined;

    return {
        efforts,
        defaultReasoning: defaultReasoning && efforts.includes( defaultReasoning ) ? defaultReasoning : efforts[0],
    };
}

function buildOpenCodeVariants( efforts: ReasoningEffort[] ): UnifiedModelCatalogEntry['opencode']['variants'] {
    return Object.fromEntries( efforts.map( effort => {
        if ( effort === 'none' ) {
            return [effort, { reasoning: { enabled: false, effort: 'none' } }];
        }

        return [
            effort,
            {
                reasoning: {
                    enabled: true,
                    effort: effort === 'max' ? 'xhigh' : effort,
                },
                verbosity: effort,
            },
        ];
    } ) );
}

function buildEffortSupport( efforts: ReasoningEffort[] ): UnifiedModelCatalogEntry['effort'] {
    return {
        supported: efforts.some( effort => effort !== 'none' ),
        ...Object.fromEntries( efforts.map( effort => [effort, { supported: true }] ) ),
    };
}

function supportsReasoningEfforts( efforts: ReasoningEffort[] ): boolean {
    return efforts.some( effort => effort !== 'none' );
}

function getReasoningLevels( efforts: ReasoningEffort[] ): Array<Exclude<ReasoningEffort, 'none'>> {
    return efforts.filter( ( effort ): effort is Exclude<ReasoningEffort, 'none'> => effort !== 'none' );
}

function getConfigModelMetas( config: ProviderConfig ): Array<{ normalizedId: string; id: string; isFree: boolean; order: number; reasoningEfforts: ReasoningEffort[]; defaultReasoning?: ReasoningEffort }> {
    return config.models.map( ( modelEntry, order ) => {
        const rawId = typeof modelEntry === 'string' ? modelEntry : modelEntry.model;
        const { normalizedId, isFree } = stripFreeModifier( rawId );
        const reasoning = getReasoningConfig( config, modelEntry );
        return { normalizedId, id: rawId, isFree, order, reasoningEfforts: reasoning.efforts, defaultReasoning: reasoning.defaultReasoning };
    } );
}

function extractModelsFromPayload( payload: any ): CatalogModel[] {
    if ( Array.isArray( payload ) ) {
        return payload.filter( item => item && typeof item === 'object' );
    }

    if ( payload && typeof payload === 'object' ) {
        if ( Array.isArray( payload.data ) ) {
            return payload.data.filter( ( item: any ) => item && typeof item === 'object' );
        }

        if ( Array.isArray( payload.models ) ) {
            return payload.models.filter( ( item: any ) => item && typeof item === 'object' );
        }

        if ( payload.models && typeof payload.models === 'object' ) {
            return Object.values( payload.models ).filter( item => item && typeof item === 'object' ) as CatalogModel[];
        }

        if ( payload.object === 'list' && Array.isArray( payload.items ) ) {
            return payload.items.filter( ( item: any ) => item && typeof item === 'object' );
        }
    }

    return [];
}

function normalizeCatalogModel( model: CatalogModel, fallbackId: string ) {
    const id = typeof model.id === 'string' && model.id.trim() ? model.id.trim() : fallbackId;
    const name = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id;
    const description = typeof model.description === 'string'
        ? model.description
        : typeof model.summary === 'string'
            ? model.summary
            : typeof model.tagline === 'string'
                ? model.tagline
                : '';
    const limit = model.limit && typeof model.limit === 'object' ? model.limit : {};
    const modalities = model.modalities && typeof model.modalities === 'object' ? model.modalities : model.modality;
    const inputModalities = Array.isArray( modalities?.input ) ? modalities.input.filter( ( value: any ) => typeof value === 'string' ) : ['text'];
    const outputModalities = Array.isArray( modalities?.output ) ? modalities.output.filter( ( value: any ) => typeof value === 'string' ) : ['text'];

    return {
        id,
        name,
        description,
        limit,
        inputModalities,
        outputModalities,
        temperatureSupported: model.temperature !== false,
        toolCallSupported: model.tool_call === true,
        reasoningSupported: model.reasoning === true,
    };
}

async function fetchProviderCatalog( config: ProviderConfig, proxyUrl?: string ): Promise<ProviderCatalog> {
    const providerName = config.id || config.name || 'provider';

    try {
        const response = await fetchWithProxy(
            buildModelsUrl( config.baseUrl ),
            {
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            },
            proxyUrl,
        );

        if ( !response.ok ) {
            throw new Error( `Model listing failed with status ${response.status}` );
        }

        const payload = await response.json();
        const models = extractModelsFromPayload( payload );
        const modelIds = models
            .map( model => normalizeCatalogModel( model, typeof model.id === 'string' ? model.id : providerName ).id )
            .filter( modelId => typeof modelId === 'string' && modelId.length > 0 );

        return {
            providerId: config.id,
            providerName,
            baseUrl: config.baseUrl,
            models,
            modelIds,
            lastFetchedAt: Date.now(),
            source: 'upstream',
        };
    } catch {
        const fallbackModelIds = config.models.map( modelEntry => ( typeof modelEntry === 'string' ? modelEntry : modelEntry.model ) );

        return {
            providerId: config.id,
            providerName,
            baseUrl: config.baseUrl,
            models: fallbackModelIds.map( modelId => ( { id: modelId } ) ),
            modelIds: fallbackModelIds,
            lastFetchedAt: Date.now(),
            source: 'config',
        };
    }
}

function mergeUnifiedCatalog( providerCatalogs: ProviderCatalog[] ): UnifiedModelCatalog {
    const byId: Record<string, UnifiedModelCatalogEntry> = {};
    const byNormalizedId: Record<string, UnifiedModelCatalogEntry> = {};
    const orderedIds: string[] = [];
    const allProviderNames = new Set<string>();

    providerCatalogs.forEach( catalog => {
        const config = CONFIG.models.openai?.find( item => item.id === catalog.providerId );
        if ( !config ) {
            return;
        }
        allProviderNames.add( catalog.providerName );

        const upstreamModelsByNormalizedId = new Map<string, CatalogModel>();

        catalog.models.forEach( ( model, modelIndex ) => {
            const normalized = normalizeCatalogModel( model, catalog.modelIds[modelIndex] ?? `${catalog.providerName}-${modelIndex}` );
            const { normalizedId } = stripFreeModifier( normalized.id );
            if ( !upstreamModelsByNormalizedId.has( normalizedId ) ) {
                upstreamModelsByNormalizedId.set( normalizedId, model );
            }
        } );

        getConfigModelMetas( config ).forEach( configMeta => {
            const upstreamModel = upstreamModelsByNormalizedId.get( configMeta.normalizedId );
            const normalized = normalizeCatalogModel( upstreamModel ?? { id: configMeta.id }, configMeta.id );
            const normalizedId = configMeta.normalizedId;
            const isFree = configMeta.isFree;
            const existing = byNormalizedId[normalizedId];

            const supportedParameters = new Set<string>( ['max_tokens'] );
            if ( normalized.temperatureSupported ) {
                supportedParameters.add( 'temperature' );
            }
            if ( normalized.toolCallSupported ) {
                supportedParameters.add( 'tools' );
            }
            const reasoningSupported = normalized.reasoningSupported || supportsReasoningEfforts( configMeta.reasoningEfforts );
            if ( reasoningSupported ) {
                supportedParameters.add( 'reasoning' );
                supportedParameters.add( 'include_reasoning' );
                supportedParameters.add( 'reasoning_effort' );
                supportedParameters.add( 'thinking' );
                supportedParameters.add( 'output_reasoning' );
            }

            const inputModalities = config.modalities?.input ?? normalized.inputModalities;
            const outputModalities = config.modalities?.output ?? normalized.outputModalities;

            const entry: UnifiedModelCatalogEntry = {
                id: configMeta.id,
                object: "model",
                name: configMeta.id,
                display_name: configMeta.id,
                description: normalized.description,
                created: MODEL_CREATED_AT,
                owned_by: 'ai-edge',
                architecture: {
                    input_modalities: inputModalities,
                    output_modalities: outputModalities,
                    tokenizer: 'Other',
                },
                top_provider: {
                    is_moderated: false,
                    context_length: typeof normalized.limit?.context === 'number'
                        ? normalized.limit.context
                        : typeof normalized.limit?.input === 'number'
                            ? normalized.limit.input
                            : 0,
                    max_completion_tokens: typeof normalized.limit?.output === 'number' ? normalized.limit.output : 0,
                },
                context_length: typeof normalized.limit?.context === 'number'
                    ? normalized.limit.context
                    : typeof normalized.limit?.input === 'number'
                        ? normalized.limit.input
                        : 0,
                supported_parameters: Array.from( supportedParameters ),
                capabilities: {
                    reasoning: reasoningSupported,
                    thinking: reasoningSupported,
                    reasoning_levels: getReasoningLevels( configMeta.reasoningEfforts ),
                },
                supports_reasoning: reasoningSupported,
                reasoning: reasoningSupported,
                reasoning_effort: reasoningSupported,
                thinking: reasoningSupported,
                output_reasoning: reasoningSupported,
                opencode: {
                    ai_sdk_provider: 'ai-edge',
                    variants: buildOpenCodeVariants( configMeta.reasoningEfforts ),
                },
                effort: buildEffortSupport( configMeta.reasoningEfforts ),
                preferredIndex: configMeta.order,
                isFree,
                providers: existing ? Array.from( new Set( [...existing.providers, catalog.providerName] ) ) : [catalog.providerName],
            };

            if ( !existing || ( existing.isFree && !entry.isFree ) ) {
                byId[entry.id] = entry;
                byNormalizedId[normalizedId] = entry;
            } else {
                existing.providers = Array.from( new Set( [...existing.providers, catalog.providerName] ) );
                existing.isFree = existing.isFree || entry.isFree;
            }

            if ( !orderedIds.includes( normalizedId ) ) {
                orderedIds.push( normalizedId );
            }
        } );
    } );

    if ( orderedIds.length > 0 && !byNormalizedId[AUTO_MODEL_ID] ) {
        const autoEntry: UnifiedModelCatalogEntry = {
            id: AUTO_MODEL_ID,
            object: "model",
            name: AUTO_MODEL_ID,
            display_name: AUTO_MODEL_ID,
            description: 'Automatically route to any configured model provider',
            created: MODEL_CREATED_AT,
            owned_by: 'ai-edge',
            architecture: {
                input_modalities: ['text'],
                output_modalities: ['text'],
                tokenizer: 'Other',
            },
            top_provider: {
                is_moderated: false,
                context_length: 0,
                max_completion_tokens: 0,
            },
            context_length: 0,
            supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning', 'reasoning_effort', 'thinking', 'output_reasoning'],
            capabilities: {
                reasoning: true,
                thinking: true,
                reasoning_levels: getReasoningLevels( DEFAULT_REASONING_EFFORTS ),
            },
            supports_reasoning: true,
            reasoning: true,
            reasoning_effort: true,
            thinking: true,
            output_reasoning: true,
            opencode: {
                ai_sdk_provider: 'ai-edge',
                variants: buildOpenCodeVariants( DEFAULT_REASONING_EFFORTS ),
            },
            effort: buildEffortSupport( DEFAULT_REASONING_EFFORTS ),
            preferredIndex: -1,
            isFree: false,
            providers: Array.from( allProviderNames ),
        };
        byId[AUTO_MODEL_ID] = autoEntry;
        byNormalizedId[AUTO_MODEL_ID] = autoEntry;
        orderedIds.unshift( AUTO_MODEL_ID );
    }

    return {
        data: orderedIds.map( normalizedId => byNormalizedId[normalizedId] ).filter( Boolean ) as UnifiedModelCatalogEntry[],
        byId,
        byNormalizedId,
        providerCatalogs: Object.fromEntries( providerCatalogs.map( catalog => [catalog.providerId, catalog] ) ),
        modelIds: orderedIds,
        lastFetchedAt: Date.now(),
    };
}

export async function refreshUnifiedModelCatalog( proxyUrl?: string, force = false ): Promise<void> {
    if ( !force && cache.lastFetchedAt > 0 ) {
        return;
    }

    if ( fetchInFlight ) {
        await fetchInFlight;
        return;
    }

    fetchInFlight = ( async () => {
        const providers = CONFIG.models.openai ?? [];
        const providerCatalogs = await Promise.all( providers.map( config => fetchProviderCatalog( config, proxyUrl ) ) );
        cache = mergeUnifiedCatalog( providerCatalogs );
    } )();

    try {
        await fetchInFlight;
    } finally {
        fetchInFlight = null;
    }
}

export async function getUnifiedModelCatalog( proxyUrl?: string ): Promise<UnifiedModelCatalog> {
    if ( cache.lastFetchedAt === 0 ) {
        await refreshUnifiedModelCatalog( proxyUrl );
    }

    return cache;
}

export function getUnifiedModelCatalogSync(): UnifiedModelCatalog {
    return cache;
}

export function getProviderModelIds( providerId: string ): string[] {
    return cache.providerCatalogs[providerId]?.modelIds ?? [];
}
