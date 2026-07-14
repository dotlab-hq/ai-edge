import type {
    BucketRecord,
    SearchOptions,
    SearchResult,
    WebSearchResponse,
    WebSearchToolConfig,
} from './types';

export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
export const SEARCH_CACHE_PREFIX = 'websearch:cache:';
export const RATE_LIMIT_PREFIX = 'websearch:rate:';

export function buildSearchResponse(
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

export function safeJsonParse(value: string): any {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function truncate(value: string, maxLength: number): string {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    const normalized = Math.trunc(value);
    return Math.min(max, Math.max(min, normalized));
}

export function buildCacheKey(query: string, options: SearchOptions): string {
    return `${SEARCH_CACHE_PREFIX}${JSON.stringify({
        q: query.trim().toLowerCase(),
        maxResults: options.maxResults ?? 5,
        topic: options.topic ?? 'general',
        maxExpandedQueries: options.maxExpandedQueries ?? 2,
        parallelQueries: options.parallelQueries ?? 2,
    })}`;
}

export function buildRateLimitKey(tool: WebSearchToolConfig): string {
    const apiKeyFragment = Buffer.from(tool.apiKey).toString('base64').slice(0, 12);
    return `${RATE_LIMIT_PREFIX}${tool.type}:${apiKeyFragment}`;
}

export function currentUtcDayWindowStart(now: Date): number {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function currentUtcMonthWindowStart(now: Date): number {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export function isCacheHitFresh(value: any): value is { expiresAt: number; payload: Omit<WebSearchResponse, 'cached'> } {
    return !!value
        && typeof value === 'object'
        && typeof value.expiresAt === 'number'
        && value.expiresAt > Date.now()
        && value.payload
        && typeof value.payload === 'object';
}

export function inferTopic(query: string): SearchOptions['topic'] {
    const normalized = query.toLowerCase();
    if (/\b(stock|stocks|price|prices|p\/e|pe ratio|eps|earnings|market cap|ticker|nasdaq|nyse)\b/.test(normalized)) {
        return 'finance';
    }
    if (/\b(news|latest|breaking|today)\b/.test(normalized)) {
        return 'news';
    }
    return 'general';
}

export function extractLikelyTickers(query: string): string[] {
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

export function buildSearchQueries(query: string, options: SearchOptions): string[] {
    const queries = [query];
    const topic = options.topic ?? inferTopic(query);

    if (topic === 'finance') {
        const tickers = extractLikelyTickers(query);
        for (const ticker of tickers) {
            queries.push(`${ticker} current stock price trailing PE ratio EPS`);
        }
    }

    return Array.from(new Set(queries)).slice(0, Math.max(1, options.maxExpandedQueries ?? 2));
}

export function refreshBucketRecord(record: BucketRecord, now: Date): BucketRecord {
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
