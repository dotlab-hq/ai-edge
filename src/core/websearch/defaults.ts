import { CONFIG } from '@/utils/schema.lookup';
import { clampInteger, inferTopic } from './utils';
import type { SearchOptions } from './types';

export type ResolvedDefaultOptions = Required<Pick<SearchOptions, 'maxResults' | 'expand' | 'maxExpandedQueries' | 'parallelQueries' | 'softTimeoutMs' | 'providerTimeoutMs'>>;

export function buildDefaultOptions(): ResolvedDefaultOptions {
    const defaults = CONFIG.tools?.webSearch?.defaults;
    return {
        maxResults: clampInteger(defaults?.maxResults, 1, 12, 6),
        expand: defaults?.expandQueries ?? true,
        maxExpandedQueries: clampInteger(defaults?.maxExpandedQueries, 1, 6, 2),
        parallelQueries: clampInteger(defaults?.parallelQueries, 1, 4, 2),
        softTimeoutMs: clampInteger(defaults?.softTimeoutMs, 1000, 30000, 8000),
        providerTimeoutMs: clampInteger(defaults?.providerTimeoutMs, 500, 30000, 7000),
    };
}

export function resolveSearchOptions(defaults: ResolvedDefaultOptions, query: string, options: SearchOptions): SearchOptions {
    return {
        maxResults: clampInteger(options.maxResults, 1, 12, defaults.maxResults),
        topic: options.topic ?? inferTopic(query),
        expand: options.expand ?? defaults.expand,
        maxExpandedQueries: clampInteger(options.maxExpandedQueries, 1, 6, defaults.maxExpandedQueries),
        parallelQueries: clampInteger(options.parallelQueries, 1, 4, defaults.parallelQueries),
        softTimeoutMs: clampInteger(options.softTimeoutMs, 1000, 30000, defaults.softTimeoutMs),
        providerTimeoutMs: clampInteger(options.providerTimeoutMs, 500, 30000, defaults.providerTimeoutMs),
    };
}
