import { expect, test } from 'bun:test';
import { WebSearchManager, type WebSearchResponse } from '../src/core/WebSearchManager';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildResponse(query: string, provider: 'tavily' | 'exa', urlSuffix: string): WebSearchResponse {
  return {
    provider,
    query,
    results: [
      {
        title: `Result ${urlSuffix}`,
        url: `https://example.com/${urlSuffix}`,
        content: `Snippet ${urlSuffix}`,
      },
    ],
    citations: [
      {
        title: `Result ${urlSuffix}`,
        url: `https://example.com/${urlSuffix}`,
        snippet: `Snippet ${urlSuffix}`,
      },
    ],
    answerText: `Answer ${urlSuffix}`,
    cached: false,
  };
}

test('search returns partial results when one expanded query misses soft timeout', async () => {
  const manager = new WebSearchManager() as any;
  manager.buildSearchQueries = () => ['slow query', 'fast query'];
  manager.searchSingle = async (query: string) => {
    if (query.includes('slow')) {
      await delay(1400);
      return buildResponse(query, 'tavily', 'slow');
    }
    await delay(20);
    return buildResponse(query, 'tavily', 'fast');
  };

  const response = await manager.search(`timeout-check-${Date.now()}`, {
    expand: true,
    maxExpandedQueries: 2,
    parallelQueries: 2,
    softTimeoutMs: 1000,
  });

  expect(response.results.length).toBe(1);
  expect(response.results[0]?.url).toContain('/fast');
});

test('search enforces maxExpandedQueries cap', async () => {
  const manager = new WebSearchManager() as any;
  const calledQueries: string[] = [];

  manager.buildSearchQueries = () => ['q1', 'q2', 'q3', 'q4'];
  manager.searchSingle = async (query: string) => {
    calledQueries.push(query);
    return buildResponse(query, 'exa', query);
  };

  const response = await manager.search(`expansion-limit-${Date.now()}`, {
    expand: true,
    maxExpandedQueries: 2,
    parallelQueries: 2,
    softTimeoutMs: 300,
  });

  expect(calledQueries.length).toBe(2);
  expect(response.results.length).toBe(2);
});

test('searchSingle falls back to next provider after timeout', async () => {
  const manager = new WebSearchManager() as any;
  const slowProvider = {
    type: 'tavily',
    search: async () => {
      await delay(120);
      return buildResponse('slow', 'tavily', 'slow');
    },
  };
  const fastProvider = {
    type: 'exa',
    search: async () => {
      await delay(10);
      return buildResponse('fast', 'exa', 'fast');
    },
  };

  manager.getConfiguredTools = () => [
    { type: 'tavily', apiKey: 'slow-key' },
    { type: 'exa', apiKey: 'fast-key' },
  ];
  manager.getAvailableTools = async (tools: any[]) => tools;
  manager.consumeRateLimit = async () => {};
  manager.getOrCreateProvider = (tool: any) => (tool.type === 'tavily' ? slowProvider : fastProvider);

  const response = await manager.searchSingle(`provider-timeout-${Date.now()}`, {
    maxResults: 5,
    providerTimeoutMs: 40,
  });

  expect(response.provider).toBe('exa');
  expect(response.results[0]?.url).toContain('/fast');
});
