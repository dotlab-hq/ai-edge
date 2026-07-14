import Exa from 'exa-js';
import { ExaSearchResults } from '@langchain/exa';
import type { SearchOptions, SearchProvider, WebSearchResponse } from './types';
import { buildSearchResponse, safeJsonParse } from './utils';

export class ExaSearchAdapter implements SearchProvider {
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

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    const normalized = Math.trunc(value);
    return Math.min(max, Math.max(min, normalized));
}
