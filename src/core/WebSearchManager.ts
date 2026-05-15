import Exa from 'exa-js';
import { ExaSearchResults } from '@langchain/exa';
import { TavilySearch } from '@langchain/tavily';
import { CACHE } from '../state';
import { CONFIG } from '@/utils/schema.lookup';
import type { Config } from '@/schema';

export interface SearchCitation {
    url: string;
    title: string;
    snippet: string;
}

export interface SearchResult {
    title: string;
    url: string;
    content: string;
    score?: number;
}

export interface WebSearchResponse {
    provider: 'tavily' | 'exa';
    query: string;
    results: SearchResult[];
    citations: SearchCitation[];
    answerText: string;
    cached: boolean;
}

type WebSearchToolConfig = NonNullable<NonNullable<Config['tools']>['webSearch']>['tools'][number];
type SearchRateLimit = WebSearchToolConfig['rateLimit'];

interface SearchOptions {
    maxResults?: number;
    topic?: 'general' | 'news' | 'finance';
    expand?: boolean;
    maxExpandedQueries?: number;
    parallelQueries?: number;
    softTimeoutMs?: number;
    providerTimeoutMs?: number;
}

interface SearchProvider {
    readonly type: 'tavily' | 'exa';
    search(query: string, options: SearchOptions): Promise<Omit<WebSearchResponse, 'cached'>>;
}

interface BucketRecord {
    minuteUsed: number;
    minuteWindowStart: number;
    dailyRequests: number;
    dayWindowStart: number;
    monthlyRequests: number;
    monthWindowStart: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_PREFIX = 'websearch:cache:';
const RATE_LIMIT_PREFIX = 'websearch:rate:';

class TavilySearchAdapter implements SearchProvider {
    readonly type = 'tavily' as const;
    private readonly tool: TavilySearch;
    private readonly maxResults: number;

    constructor(apiKey: string, options?: { maxResults?: number; searchDepth?: 'basic' | 'advanced'; includeRawContent?: boolean; includeAnswer?: boolean }) {
        this.maxResults = clampInteger(options?.maxResults, 1, 10, 6);
        this.tool = new TavilySearch({
            tavilyApiKey: apiKey,
            includeAnswer: options?.includeAnswer ?? true,
            includeRawContent: options?.includeRawContent ? 'text' : false,
            maxResults: this.maxResults,
            searchDepth: options?.searchDepth ?? 'basic',
            includeFavicon: false,
            includeUsage: false,
        });
    }

    async search(query: string, options: SearchOptions): Promise<Omit<WebSearchResponse, 'cached'>> {
        const raw = await this.tool.invoke({
            query,
            topic: options.topic,
        }) as any;

        const results = Array.isArray(raw?.results)
            ? raw.results.map((result: any) => ({
                title: String(result?.title ?? ''),
                url: String(result?.url ?? ''),
                content: String(result?.content ?? result?.raw_content ?? ''),
                score: typeof result?.score === 'number' ? result.score : undefined,
            }))
            : [];

        const limitedResults = results.slice(0, options.maxResults ?? 5);
        return buildSearchResponse('tavily', query, limitedResults, raw?.answer);
    }
}

class ExaSearchAdapter implements SearchProvider {
    readonly type = 'exa' as const;
    private readonly tool: ExaSearchResults<{ text: true }>;
    private readonly maxResults: number;

    constructor(apiKey: string, options?: { maxResults?: number }) {
        this.maxResults = clampInteger(options?.maxResults, 1, 10, 6);
        this.tool = new ExaSearchResults({
            client: new Exa(apiKey),
            searchArgs: {
                numResults: this.maxResults,
                text: true,
            },
        });
    }

    async search(query: string, options: SearchOptions): Promise<Omit<WebSearchResponse, 'cached'>> {
        const raw = await this.tool.invoke(query);
        const parsed = safeJsonParse(raw);
        const results = Array.isArray(parsed?.results)
            ? parsed.results.map((result: any) => ({
                title: String(result?.title ?? ''),
                url: String(result?.url ?? result?.id ?? ''),
                content: String(result?.text ?? result?.snippet ?? result?.highlights?.join?.(' ') ?? ''),
                score: typeof result?.score === 'number' ? result.score : undefined,
            }))
            : [];

        const limitedResults = results.slice(0, options.maxResults ?? 5);
        return buildSearchResponse('exa', query, limitedResults);
    }
}

function buildSearchResponse(
    provider: 'tavily' | 'exa',
    query: string,
    results: SearchResult[],
    answer?: string
): Omit<WebSearchResponse, 'cached'> {
    const citations = results.map((result) => ({
        url: result.url,
        title: result.title,
        snippet: truncate(result.content, 240),
    }));

    const answerText = answer?.trim()
        ? answer.trim()
        : results.map((result, index) => `[${index + 1}] ${result.title}: ${truncate(result.content, 220)}`).join('\n');

    return {
        provider,
        query,
        results,
        citations,
        answerText,
    };
}

function safeJsonParse(value: string): any {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function truncate(value: string, maxLength: number): string {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    const normalized = Math.trunc(value);
    return Math.min(max, Math.max(min, normalized));
}

function buildCacheKey(query: string, options: SearchOptions): string {
    return `${SEARCH_CACHE_PREFIX}${JSON.stringify({
        q: query.trim().toLowerCase(),
        maxResults: options.maxResults ?? 5,
        topic: options.topic ?? 'general',
        maxExpandedQueries: options.maxExpandedQueries ?? 2,
        parallelQueries: options.parallelQueries ?? 2,
    })}`;
}

function buildRateLimitKey(tool: WebSearchToolConfig): string {
    const apiKeyFragment = Buffer.from(tool.apiKey).toString('base64').slice(0, 12);
    return `${RATE_LIMIT_PREFIX}${tool.type}:${apiKeyFragment}`;
}

function currentUtcDayWindowStart(now: Date): number {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function currentUtcMonthWindowStart(now: Date): number {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function isCacheHitFresh(value: any): value is { expiresAt: number; payload: Omit<WebSearchResponse, 'cached'> } {
    return !!value
        && typeof value === 'object'
        && typeof value.expiresAt === 'number'
        && value.expiresAt > Date.now()
        && value.payload
        && typeof value.payload === 'object';
}

export class WebSearchManager {
    private readonly providers = new Map<string, SearchProvider>();
    private readonly defaultOptions = this.getDefaultOptions();

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

        const searchOptions = this.resolveOptions(normalizedQuery, options);

        const expandedQueries = searchOptions.expand === false
            ? [normalizedQuery]
            : this.buildSearchQueries(normalizedQuery, searchOptions).slice(0, searchOptions.maxExpandedQueries ?? 2);

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
                await this.consumeRateLimit(tool);
                const provider = this.getOrCreateProvider(tool);
                const timeoutMs = this.getProviderTimeout(tool, options);
                const response = await this.withTimeout(
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

    private buildSearchQueries(query: string, options: SearchOptions): string[] {
        const queries = [query];
        const topic = options.topic ?? this.inferTopic(query);

        if (topic === 'finance') {
            const tickers = this.extractLikelyTickers(query);
            for (const ticker of tickers) {
                queries.push(`${ticker} current stock price trailing PE ratio EPS`);
            }
        }

        return Array.from(new Set(queries)).slice(0, Math.max(1, options.maxExpandedQueries ?? 2));
    }

    private inferTopic(query: string): SearchOptions['topic'] {
        const normalized = query.toLowerCase();
        if (/\b(stock|stocks|price|prices|p\/e|pe ratio|eps|earnings|market cap|ticker|nasdaq|nyse)\b/.test(normalized)) {
            return 'finance';
        }
        if (/\b(news|latest|breaking|today)\b/.test(normalized)) {
            return 'news';
        }
        return 'general';
    }

    private extractLikelyTickers(query: string): string[] {
        const ignored = new Set([
            'A', 'AN', 'AND', 'API', 'EPS', 'FOR', 'GO', 'HAS', 'I', 'IPO', 'LLM', 'NASDAQ', 'NYSE', 'PE',
            'RATIO', 'SEARCH', 'THE', 'THEN', 'TO', 'TTM', 'VS', 'WHICH',
        ]);

        return Array.from(query.matchAll(/\b[A-Z]{1,5}\b/g))
            .map((match) => match[0])
            .filter((value) => !ignored.has(value))
            .filter((value, index, values) => values.indexOf(value) === index)
            .slice(0, 4);
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

        const record = await this.getBucket(tool);
        const now = new Date();
        const refreshed = this.refreshRecord(record, now);
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

    private async consumeRateLimit(tool: WebSearchToolConfig): Promise<void> {
        const limit = tool.rateLimit;
        if (!limit) {
            return;
        }

        const key = buildRateLimitKey(tool);
        const record = this.refreshRecord(await this.getBucket(tool), new Date());
        const minuteLimit = limit.requestsPerMinute;
        const dayLimit = limit.requestsPerDay;
        const monthLimit = limit.requestsPerMonth;

        if (typeof minuteLimit === 'number' && record.minuteUsed + 1 > minuteLimit) {
            throw new Error(`Web search rate limit exceeded for ${tool.type} (minute)`);
        }
        if (typeof dayLimit === 'number' && record.dailyRequests + 1 > dayLimit) {
            throw new Error(`Web search rate limit exceeded for ${tool.type} (day)`);
        }
        if (typeof monthLimit === 'number' && record.monthlyRequests + 1 > monthLimit) {
            throw new Error(`Web search rate limit exceeded for ${tool.type} (month)`);
        }

        record.minuteUsed += 1;
        record.dailyRequests += 1;
        record.monthlyRequests += 1;
        await CACHE.setKey(key, record);
    }

    private async getBucket(tool: WebSearchToolConfig): Promise<BucketRecord> {
        const key = buildRateLimitKey(tool);
        const existing = await CACHE.getKey<BucketRecord>(key);
        if (existing) {
            return existing;
        }

        const now = new Date();
        const initial: BucketRecord = {
            minuteUsed: 0,
            minuteWindowStart: Math.floor(now.getTime() / 60000) * 60000,
            dailyRequests: 0,
            dayWindowStart: currentUtcDayWindowStart(now),
            monthlyRequests: 0,
            monthWindowStart: currentUtcMonthWindowStart(now),
        };
        await CACHE.setKey(key, initial);
        return initial;
    }

    private refreshRecord(record: BucketRecord, now: Date): BucketRecord {
        const minuteWindowStart = Math.floor(now.getTime() / 60000) * 60000;
        const dayWindowStart = currentUtcDayWindowStart(now);
        const monthWindowStart = currentUtcMonthWindowStart(now);

        if (record.minuteWindowStart !== minuteWindowStart) {
            record.minuteWindowStart = minuteWindowStart;
            record.minuteUsed = 0;
        }
        if (record.dayWindowStart !== dayWindowStart) {
            record.dayWindowStart = dayWindowStart;
            record.dailyRequests = 0;
        }
        if (record.monthWindowStart !== monthWindowStart) {
            record.monthWindowStart = monthWindowStart;
            record.monthlyRequests = 0;
        }

        return record;
    }

    private getDefaultOptions(): Required<Pick<SearchOptions, 'maxResults' | 'expand' | 'maxExpandedQueries' | 'parallelQueries' | 'softTimeoutMs' | 'providerTimeoutMs'>> {
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

    private resolveOptions(query: string, options: SearchOptions): SearchOptions {
        return {
            maxResults: clampInteger(options.maxResults, 1, 12, this.defaultOptions.maxResults),
            topic: options.topic ?? this.inferTopic(query),
            expand: options.expand ?? this.defaultOptions.expand,
            maxExpandedQueries: clampInteger(options.maxExpandedQueries, 1, 6, this.defaultOptions.maxExpandedQueries),
            parallelQueries: clampInteger(options.parallelQueries, 1, 4, this.defaultOptions.parallelQueries),
            softTimeoutMs: clampInteger(options.softTimeoutMs, 1000, 30000, this.defaultOptions.softTimeoutMs),
            providerTimeoutMs: clampInteger(options.providerTimeoutMs, 500, 30000, this.defaultOptions.providerTimeoutMs),
        };
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
                    const response = await this.withTimeout(
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

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
        if (timeoutMs <= 0) {
            throw new Error(message);
        }

        return await new Promise<T>((resolve, reject) => {
            const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
            promise.then(
                (value) => {
                    clearTimeout(timeoutId);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                }
            );
        });
    }

    private getProviderTimeout(tool: WebSearchToolConfig, options: SearchOptions): number {
        return clampInteger(tool.timeoutMs, 500, 30000, options.providerTimeoutMs ?? this.defaultOptions.providerTimeoutMs);
    }
}

export const webSearchManager = new WebSearchManager();
