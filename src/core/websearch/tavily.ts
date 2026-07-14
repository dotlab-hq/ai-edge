import { TavilySearch } from '@langchain/tavily';
import type { SearchOptions, SearchProvider, WebSearchResponse } from './types';
import { buildSearchResponse } from './utils';

export class TavilySearchAdapter implements SearchProvider {
    readonly type = 'tavily' as const;
    private readonly tool: TavilySearch;
    private readonly maxResults: number;

    constructor(apiKey: string, options?: {
        maxResults?: number;
        searchDepth?: 'basic' | 'advanced';
        includeRawContent?: boolean;
        includeAnswer?: boolean;
    }) {
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

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    const normalized = Math.trunc(value);
    return Math.min(max, Math.max(min, normalized));
}
