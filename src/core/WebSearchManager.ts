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

    constructor(apiKey: string) {
        this.tool = new TavilySearch({
            tavilyApiKey: apiKey,
            includeAnswer: true,
            includeRawContent: 'text',
            maxResults: 10,
            searchDepth: 'advanced',
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

    constructor(apiKey: string) {
        this.tool = new ExaSearchResults({
            client: new Exa(apiKey),
            searchArgs: {
                numResults: 10,
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

function buildCacheKey(query: string, options: SearchOptions): string {
    return `${SEARCH_CACHE_PREFIX}${JSON.stringify({
        q: query.trim().toLowerCase(),
        maxResults: options.maxResults ?? 5,
        topic: options.topic ?? 'general',
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

    isEnabled(): boolean {
        return (CONFIG.tools?.webSearch?.tools?.length ?? 0) > 0;
    }

    getConfiguredTools(): WebSearchToolConfig[] {
        return CONFIG.tools?.webSearch?.tools ?? [];
    }

    async search(query: string, options: SearchOptions = {}): Promise<WebSearchResponse> {
        const normalizedQuery = query.trim();
        if (!normalizedQuery) {
            throw new Error('Search query is required');
        }

        const configuredTools = this.getConfiguredTools();
        if (!configuredTools.length) {
            throw new Error('Web search is not configured');
        }

        const inferredTopic = options.topic ?? this.inferTopic(normalizedQuery);
        const searchOptions = {
            ...options,
            topic: inferredTopic,
        };

        const expandedQueries = searchOptions.expand === false
            ? [normalizedQuery]
            : this.buildSearchQueries(normalizedQuery, searchOptions);

        const responses: WebSearchResponse[] = [];
        for (const expandedQuery of expandedQueries) {
            responses.push(await this.searchSingle(expandedQuery, {
                ...searchOptions,
                expand: false,
            }));
        }

        return this.mergeResponses(normalizedQuery, responses);
    }

    private async searchSingle(query: string, options: SearchOptions): Promise<WebSearchResponse> {
        const normalizedQuery = query.trim();
        const configuredTools = this.getConfiguredTools();
        const orderedTools = await this.getAvailableTools(configuredTools);
        let lastError: unknown;

        const cacheKey = buildCacheKey(normalizedQuery, options);
        const cached = await CACHE.getKey<any>(cacheKey);
        if (isCacheHitFresh(cached)) {
            return {
                ...cached.payload,
                cached: true,
            };
        }

        for (const tool of orderedTools) {
            try {
                await this.consumeRateLimit(tool);
                const provider = this.getOrCreateProvider(tool);
                const response = await provider.search(normalizedQuery, options);
                await CACHE.setKey(cacheKey, {
                    expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
                    payload: response,
                });
                return {
                    ...response,
                    cached: false,
                };
            } catch (error) {
                lastError = error;
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

        return Array.from(new Set(queries)).slice(0, 4);
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
        const key = `${tool.type}:${tool.apiKey}`;
        const existing = this.providers.get(key);
        if (existing) {
            return existing;
        }

        const provider = tool.type === 'tavily'
            ? new TavilySearchAdapter(tool.apiKey)
            : new ExaSearchAdapter(tool.apiKey);

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
}

export const webSearchManager = new WebSearchManager();
