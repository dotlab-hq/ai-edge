import { stripFreeModifier } from '@/utils/modelIds';
import type { ProviderConfig, ConfigModelEntry, ReasoningEffort, CatalogModel, UnifiedModelCatalogEntry } from './catalogTypes';

export const AUTO_MODEL_ID = 'Auto-Edge';
export const MODEL_CREATED_AT = Math.floor( Date.now() / 1000 );

export const DEFAULT_REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high'];

export function normalizeBaseUrl( baseUrl: string ): string {
    return baseUrl.replace( /\/+$/, '' );
}

export function buildModelsUrl( baseUrl: string ): string {
    return `${normalizeBaseUrl( baseUrl )}/models`;
}

export function isModelObject( modelEntry: ConfigModelEntry | undefined ): modelEntry is Extract<ConfigModelEntry, object> {
    return typeof modelEntry === 'object' && modelEntry !== null;
}

export function hasReasoningConfigured( value: { reasoning_efforts?: ReasoningEffort[]; default_reasoning?: ReasoningEffort } ): boolean {
    return Object.prototype.hasOwnProperty.call( value, 'reasoning_efforts' )
        || Object.prototype.hasOwnProperty.call( value, 'default_reasoning' );
}

export function getReasoningConfig( config: ProviderConfig, modelEntry?: ConfigModelEntry ): { efforts: ReasoningEffort[]; defaultReasoning?: ReasoningEffort } {
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

export function buildOpenCodeVariants( efforts: ReasoningEffort[] ): UnifiedModelCatalogEntry['opencode']['variants'] {
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

export function buildEffortSupport( efforts: ReasoningEffort[] ): UnifiedModelCatalogEntry['effort'] {
    return {
        supported: efforts.some( effort => effort !== 'none' ),
        ...Object.fromEntries( efforts.map( effort => [effort, { supported: true }] ) ),
    };
}

export function supportsReasoningEfforts( efforts: ReasoningEffort[] ): boolean {
    return efforts.some( effort => effort !== 'none' );
}

export function getReasoningLevels( efforts: ReasoningEffort[] ): Array<Exclude<ReasoningEffort, 'none'>> {
    return efforts.filter( ( effort ): effort is Exclude<ReasoningEffort, 'none'> => effort !== 'none' );
}

export function getConfigModelMetas( config: ProviderConfig ): Array<{ normalizedId: string; id: string; isFree: boolean; order: number; reasoningEfforts: ReasoningEffort[]; defaultReasoning?: ReasoningEffort }> {
    return config.models.map( ( modelEntry, order ) => {
        const rawId = typeof modelEntry === 'string' ? modelEntry : modelEntry.model;
        const { normalizedId, isFree } = stripFreeModifier( rawId );
        const reasoning = getReasoningConfig( config, modelEntry );
        return { normalizedId, id: rawId, isFree, order, reasoningEfforts: reasoning.efforts, defaultReasoning: reasoning.defaultReasoning };
    } );
}

export function extractModelsFromPayload( payload: any ): CatalogModel[] {
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

export function normalizeCatalogModel( model: CatalogModel, fallbackId: string ) {
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

export function buildAutoModelEntry( allProviderNames: Set<string> ): UnifiedModelCatalogEntry {
    return {
        id: AUTO_MODEL_ID,
        object: "model",
        name: AUTO_MODEL_ID,
        display_name: AUTO_MODEL_ID,
        description: 'Automatically route to any configured model provider',
        created: MODEL_CREATED_AT,
        owned_by: 'ai-edge',
        architecture: {
            input_modalities: ['text', 'image', 'audio', 'file'],
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
        modalities: {
            input: ['text', 'image', 'audio', 'file'],
            output: ['text'],
        },
        capabilities: {
            vision: true,
            image_input: true,
            reasoning: true,
            thinking: true,
            reasoning_levels: getReasoningLevels( DEFAULT_REASONING_EFFORTS ),
            stt: false,
        },
        supports_vision: true,
        supports_images: true,
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
}
