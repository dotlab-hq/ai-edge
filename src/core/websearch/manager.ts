import { CACHE } from '../../state';
import { CONFIG } from '@/utils/schema.lookup';
import {
    ExaSearchAdapter,
} from './exa';
import { TavilySearchAdapter } from './tavily';
import { consumeRateLimit, getBucket } from './rateLimit';
import {
    buildDefaultOptions,
    resolveSearchOptions,
} from './defaults';
import {
    buildCacheKey,
    buildSearchQueries,
    buildSearchResponse,
    DEFAULT_CACHE_TTL_MS,
    isCacheHitFresh,
    refreshBucketRecord,
} from './utils';
import { getProviderTimeout, withTimeout } from './timeout';
import type {
    BucketRecord,
    SearchOptions,
    SearchProvider,
    SearchResult,
    WebSearchResponse,
    WebSearchToolConfig,
} from './types';

export class WebSearchManager {
    private readonly providers = new Map<string, SearchProvider>();
    private readonly defaultOptions = buildDefaultOptions();

    isEnabled(): boolean {
        return (CONFIG.tools?.webSearch?.tools?.length ?? 0) > 0;
    }

    getConfiguredTools(): WebSearchToolConfig[] {
        return CONFIG.tools?.webSearch?.tools ?? [];
    }

    async search(query: string, options: SearchOptions = {}): Promise<WebSearchResponse> {
        const startedAt = Date.now();
        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
            throw new Error('Search query is required');
        }

        const configuredTools = this.getConfiguredTools();
        if (!configuredTools.length) {
            throw new Error('Web search is not configured');
        }

        const searchOptions = resolveSearchOptions(this.defaultOptions, normalizedQuery, options);

        const expandedQueries = searchOptions.expand === false
            ? [normalizedQuery]
            : buildSearchQueries(normalizedQuery, searchOptions).slice(0, searchOptions.maxExpandedQueries ?? 2);

        const responses = await this.searchExpandedQueries(expandedQueries, searchOptions);
        if (!responses.length) {
            throw new Error('Web search providers did not return results before timeout');
        }

        const merged = this.mergeResponses(normalizedQuery, responses);
        console.info(`[web-search] complete query="${normalizedQuery}" durationMs=${Date.now() - startedAt} expandedQueries=${expandedQueries.length} returnedResults=${merged.results.length} cached=${merged.cached}`);
        return merged;
    }

    private async searchSingle(query: string, options: SearchOptions): Promise<WebSearchResponse> {
        const startedAt = Date.now();
        const normalizedQuery = query.trim();
        const configuredTools = this.getConfiguredTools();
        const orderedTools = await this.getAvailableTools(configuredTools);
        let lastError: unknown;

        const cacheKey = buildCacheKey(normalizedQuery, options);
        const cached = await CACHE.getKey<any>(cacheKey);
        if (isCacheHitFresh(cached)) {
            console.info(`[web-search] cache_hit query="${normalizedQuery}" durationMs=${Date.now() - startedAt}`);
            return {
                ...cached.payload,
                cached: true,
            };
        }

        for (const tool of orderedTools) {
            try {
                await consumeRateLimit(tool);
                const provider = this.getOrCreateProvider(tool);
                const timeoutMs = getProviderTimeout(tool, options, this.defaultOptions);
                const response = await withTimeout(
                    provider.search(normalizedQuery, options),
                    timeoutMs,
                    `Web search provider timeout for ${tool.type}`
                );
                await CACHE.setKey(cacheKey, {
                    expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
                    payload: response,
                });
                console.info(`[web-search] provider_success query="${normalizedQuery}" provider=${tool.type} durationMs=${Date.now() - startedAt} timeoutMs=${timeoutMs}`);
                return {
                    ...response,
                    cached: false,
                };
            } catch (error) {
                lastError = error;
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[web-search] provider_error query="${normalizedQuery}" provider=${tool.type} durationMs=${Date.now() - startedAt} error="${message}"`);
            }
        }

        throw lastError instanceof Error ? lastError : new Error('No web search providers available');
    }

    private mergeResponses(query: string, responses: WebSearchResponse[]): WebSearchResponse {
        const resultsByUrl = new Map<string, SearchResult>();
        let provider = responses[0]?.provider ?? 'tavily';
        let cached = responses.length > 0 && responses.every((response) => response.cached);

        for (const response of responses) {
            provider = response.provider;
            for (const result of response.results) {
                if (!result.url || resultsByUrl.has(result.url)) {
                    continue;
                }
                resultsByUrl.set(result.url, result);
            }
        }

        const results = Array.from(resultsByUrl.values()).slice(0, 12);
        const merged = buildSearchResponse(provider, query, results);

        return {
            ...merged,
            cached,
        };
    }

    private getOrCreateProvider(tool: WebSearchToolConfig): SearchProvider {
        const key = `${tool.type}:${tool.apiKey}:${JSON.stringify(tool.options ?? {})}`;
        const existing = this.providers.get(key);
        if (existing) {
            return existing;
        }

        const provider = tool.type === 'tavily'
            ? new TavilySearchAdapter(tool.apiKey, {
                maxResults: tool.options?.maxResults,
                searchDepth: tool.options?.searchDepth,
                includeRawContent: tool.options?.includeRawContent,
                includeAnswer: tool.options?.includeAnswer,
            })
            : new ExaSearchAdapter(tool.apiKey, {
                maxResults: tool.options?.maxResults,
            });

        this.providers.set(key, provider);
        return provider;
    }

    private async getAvailableTools(tools: WebSearchToolConfig[]): Promise<WebSearchToolConfig[]> {
        const scored = await Promise.all(tools.map(async (tool) => ({
            tool,
            remaining: await this.getQuotaScore(tool),
        })));

        return scored
            .filter((entry) => entry.remaining > 0)
            .sort((left, right) => right.remaining - left.remaining)
            .map((entry) => entry.tool);
    }

    private async getQuotaScore(tool: WebSearchToolConfig): Promise<number> {
        const limit = tool.rateLimit;
        if (!limit) {
            return Number.MAX_SAFE_INTEGER;
        }

        const record = await getBucket(tool);
        const now = new Date();
        const refreshed = refreshBucketRecord(record, now);
        const minuteRemaining = typeof limit.requestsPerMinute === 'number'
            ? Math.max(0, limit.requestsPerMinute - refreshed.minuteUsed)
            : Number.MAX_SAFE_INTEGER;
        const dayRemaining = typeof limit.requestsPerDay === 'number'
            ? Math.max(0, limit.requestsPerDay - refreshed.dailyRequests)
            : Number.MAX_SAFE_INTEGER;
        const monthRemaining = typeof limit.requestsPerMonth === 'number'
            ? Math.max(0, limit.requestsPerMonth - refreshed.monthlyRequests)
            : Number.MAX_SAFE_INTEGER;

        return Math.min(minuteRemaining, dayRemaining, monthRemaining);
    }

    private async searchExpandedQueries(queries: string[], options: SearchOptions): Promise<WebSearchResponse[]> {
        const responses: WebSearchResponse[] = [];
        const softTimeoutMs = options.softTimeoutMs ?? this.defaultOptions.softTimeoutMs;
        const deadline = Date.now() + softTimeoutMs;
        const concurrency = Math.min(queries.length, options.parallelQueries ?? this.defaultOptions.parallelQueries);
        let nextIndex = 0;
        const errors: unknown[] = [];

        const runWorker = async () => {
            while (nextIndex < queries.length && Date.now() < deadline) {
                const query = queries[nextIndex];
                nextIndex += 1;
                if (!query) {
                    continue;
                }

                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    return;
                }

                try {
                    const response = await withTimeout(
                        this.searchSingle(query, { ...options, expand: false }),
                        remaining,
                        `Web search query timed out for "${query}"`
                    );
                    responses.push(response);
                } catch (error) {
                    errors.push(error);
                }
            }
        };

        await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

        if (!responses.length && errors.length > 0) {
            throw errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
        }

        return responses;
    }

}

export const webSearchManager = new WebSearchManager();
