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

export type WebSearchToolConfig = NonNullable<NonNullable<Config['tools']>['webSearch']>['tools'][number];
export type SearchRateLimit = WebSearchToolConfig['rateLimit'];

export interface SearchOptions {
    maxResults?: number;
    topic?: 'general' | 'news' | 'finance';
    expand?: boolean;
    maxExpandedQueries?: number;
    parallelQueries?: number;
    softTimeoutMs?: number;
    providerTimeoutMs?: number;
}

export interface SearchProvider {
    readonly type: 'tavily' | 'exa';
    search(query: string, options: SearchOptions): Promise<Omit<WebSearchResponse, 'cached'>>;
}

export interface BucketRecord {
    minuteUsed: number;
    minuteWindowStart: number;
    dailyRequests: number;
    dayWindowStart: number;
    monthlyRequests: number;
    monthWindowStart: number;
}
