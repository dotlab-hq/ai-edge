import { mergeUnifiedCatalog, fetchProviderCatalog } from './catalogMerge';
import { CONFIG } from '@/utils/schema.lookup';
import type { UnifiedModelCatalog } from './catalogTypes';
import { EMPTY_CATALOG } from './catalogTypes';

export type { UnifiedModelCatalogEntry, UnifiedModelCatalog, ProviderCatalog, CatalogModel } from './catalogTypes';

let cache: UnifiedModelCatalog = EMPTY_CATALOG;
let fetchInFlight: Promise<void> | null = null;

export async function refreshUnifiedModelCatalog( proxyUrl?: string, force = false ): Promise<void> {
    if ( !force && cache.lastFetchedAt > 0 ) {
        return;
    }

    if ( fetchInFlight ) {
        await fetchInFlight;
        return;
    }

    fetchInFlight = ( async () => {
        const providers = CONFIG.models.openai ?? [];
        const providerCatalogs = await Promise.all( providers.map( config => fetchProviderCatalog( config, proxyUrl ) ) );
        cache = mergeUnifiedCatalog( providerCatalogs );
    } )();

    try {
        await fetchInFlight;
    } finally {
        fetchInFlight = null;
    }
}

export async function getUnifiedModelCatalog( proxyUrl?: string ): Promise<UnifiedModelCatalog> {
    if ( cache.lastFetchedAt === 0 ) {
        await refreshUnifiedModelCatalog( proxyUrl );
    }

    return cache;
}

export function getUnifiedModelCatalogSync(): UnifiedModelCatalog {
    return cache;
}

export function getProviderModelIds( providerId: string ): string[] {
    return cache.providerCatalogs[providerId]?.modelIds ?? [];
}
