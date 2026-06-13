import { fetchWithProxy } from '@/utils/proxyFetch';
import { CONFIG } from '@/utils/schema.lookup';

export interface FileSearchResult {
    file_id: string;
    filename: string;
    text: string;
    score: number;
    attributes?: Record<string, string | number | boolean>;
}

export interface FileSearchResponse {
    results: FileSearchResult[];
    queries: string[];
    cached: boolean;
}

interface FileSearchToolDef {
    type: 'file_search';
    vector_store_ids: string[];
    max_num_results?: number;
}

/**
 * Server-side file search proxy. When the client sends a `file_search` tool
 * in a Responses API request, this manager queries the configured vector store
 * and returns results that are injected as context before forwarding upstream.
 */
export class FileSearchManager {
    isEnabled(): boolean {
        return !!CONFIG.vectorStore;
    }

    private getVectorStoreConfig() {
        return CONFIG.vectorStore;
    }

    /**
     * Execute a file search across one or more vector stores.
     */
    async search(
        queries: string[],
        vectorStoreIds: string[],
        options?: { maxResults?: number },
    ): Promise<FileSearchResponse> {
        const startedAt = Date.now();
        const vs = this.getVectorStoreConfig();
        if (!vs) {
            throw new Error('Vector store is not configured');
        }

        const maxResults = Math.min(options?.maxResults ?? 20, 50);
        const base = vs.url.replace(/\/+$/, '');
        const allResults: FileSearchResult[] = [];

        for (const vsId of vectorStoreIds) {
            try {
                const url = `${base}/vector_stores/${vsId}/search`;
                const response = await fetchWithProxy(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${vs.apiKey}`,
                    },
                    body: JSON.stringify({
                        queries,
                        max_num_results: maxResults,
                    }),
                }, CONFIG.proxy);

                if (!response.ok) {
                    const body = await response.text().catch(() => '');
                    console.warn(
                        `[file-search] vector_store_error store=${vsId} status=${response.status} body=${body.slice(0, 200)}`,
                    );
                    continue;
                }

                const payload = await response.json() as any;
                const data = Array.isArray(payload?.data) ? payload.data : [];
                for (const item of data) {
                    allResults.push({
                        file_id: item?.file_id ?? item?.id ?? '',
                        filename: item?.filename ?? item?.attributes?.filename ?? '',
                        text: item?.content ?? item?.text ?? item?.chunk ?? '',
                        score: typeof item?.score === 'number' ? item.score : 0,
                        attributes: item?.attributes,
                    });
                }
            } catch (err: any) {
                console.warn(
                    `[file-search] vector_store_error store=${vsId} error=${err?.message || String(err)}`,
                );
            }
        }

        // Sort by score descending and take top results
        allResults.sort((a, b) => b.score - a.score);
        const limited = allResults.slice(0, maxResults);

        console.info(
            `[file-search] complete queries=${queries.length} vectorStores=${vectorStoreIds.length} `
            + `results=${limited.length} durationMs=${Date.now() - startedAt}`,
        );

        return {
            results: limited,
            queries,
            cached: false,
        };
    }
}

export const fileSearchManager = new FileSearchManager();
