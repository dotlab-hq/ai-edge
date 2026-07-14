import type { Config } from '@/schema';

export type ProviderConfig = NonNullable<Config['models']['openai']>[number];
export type ConfigModelEntry = ProviderConfig['models'][number];
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type CatalogModel = Record<string, any>;

export type ProviderCatalog = {
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
    modalities: {
        input: string[];
        output: string[];
    };
    capabilities: {
        vision: boolean;
        image_input: boolean;
        reasoning: boolean;
        thinking: boolean;
        reasoning_levels: Array<Exclude<ReasoningEffort, 'none'>>;
        stt: boolean;
    };
    supports_vision: boolean;
    supports_images: boolean;
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

export const EMPTY_CATALOG: UnifiedModelCatalog = {
    data: [],
    byId: {},
    byNormalizedId: {},
    providerCatalogs: {},
    modelIds: [],
    lastFetchedAt: 0,
};
