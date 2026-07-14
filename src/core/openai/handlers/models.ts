import type { Context } from 'hono';
import { CONFIG } from '@/utils/schema.lookup';
import { getUnifiedModelCatalog } from '@/utils/modelCatalog';

export async function handleModels( c: Context ) {
    try {
        const configs = CONFIG.models.openai ?? [];
        if ( !configs.length ) {
            console.error( '[/v1/models] No backend configured' );
            return c.json( { error: 'No backend configured' }, 503 );
        }

        const catalog = await getUnifiedModelCatalog( CONFIG.proxy );
        return c.json( {
            object: 'list',
            data: catalog.data,
        } );
    } catch ( error: any ) {
        console.error( '[/v1/models] Exception:', error?.message || String( error ) );
        return c.json( { error: 'Failed to fetch models' }, 500 );
    }
}
