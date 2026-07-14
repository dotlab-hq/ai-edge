import type { Config } from '@/schema';
import type { ProviderStatsTracker } from '../ProviderStatsTracker';

export type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
export type ReasoningEffort = NonNullable<OpenAIModelConfig['default_reasoning']>;
export type RateLimit = Config['rateLimit'];

export const AUTO_MODEL_ID = 'auto';
export const FAST_MODEL_HINTS = ['flash-lite', 'lite', 'mini', 'small', 'fast'];

export interface BackendState {
    readonly rrIndexByKey: Map<string, number>;
    readonly providerStats: ProviderStatsTracker;
    readonly backendRouteCache: Map<string, OpenAIModelConfig[]>;
    readonly optimizedBackendCache: Map<string, { backends: OpenAIModelConfig[]; expiresAt: number }>;
}
