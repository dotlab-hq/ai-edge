import type { Config } from '@/schema';

export type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
export type OpenAIModelEntry = OpenAIModelConfig['models'][number];

export const AUTO_MODEL_ID = 'auto';

export type RoutingEndpoint =
    | 'chat/completions'
    | 'completions'
    | 'responses'
    | 'messages'
    | 'embeddings'
    | 'images/generations'
    | 'images/edits';

export const SUPPORTED_ENDPOINTS: readonly RoutingEndpoint[] = [
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

export type CompiledRoutingProvider = RoutingProviderSnapshot & {
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

export type RoutingSnapshotConfigResolver = () => ReadonlyArray<OpenAIModelConfig> | undefined;
