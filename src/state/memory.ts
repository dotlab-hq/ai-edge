import Cache from "../core/Cache";
import type { JSONable } from "../core/Cache";
import { CONFIG } from "@/utils/schema.lookup";
import type { Config } from "@/schema";

type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
type TransformedModel = Omit<OpenAIModelConfig, 'models'> & {
    models: Array<{ model: string; rateLimit: OpenAIModelConfig['rateLimit'] }>
};

export class MemoryCache extends Cache {
    constructor( initial?: JSONable ) {
        super( initial );
    }

    async getJson(): Promise<JSONable> {
        const data = this.extractConfigData();
        this.loadFromJSON( data );
        return this.toJSON();
    }

    async refresh(): Promise<JSONable> {
        const data = this.extractConfigData();
        this.loadFromJSON( data );
        return this.toJSON();
    }

    override async clearCache(): Promise<void> {
        this.store.clear();
    }

    async setJson( obj: JSONable ): Promise<void> {
        this.loadFromJSON( obj );
    }

    private extractConfigData(): JSONable {
        const result: JSONable = {};
        if ( CONFIG.models?.openai ) {
            result.models = { openai: this.transformOpenAIModels( CONFIG.models.openai ) as any };
        }
        return result;
    }

    private transformOpenAIModels( models: OpenAIModelConfig[] ): OpenAIModelConfig[] | TransformedModel[] {
        return models.map( ( model ) => {
            // If models entries are objects with their own rateLimit, transform to per-model entries
            const first = model.models && model.models[0];
            const firstIsObject = typeof first === 'object' && first !== null;

            if ( firstIsObject ) {
                // model.models is an array of { model, rateLimit }
                const transformed: TransformedModel = {
                    // Keep provider-level fields except backend rateLimit
                    id: model.id,
                    name: model.name,
                    baseUrl: ( model as any ).baseUrl,
                    apiKey: ( model as any ).apiKey,
                    randomRouting: ( model as any ).randomRouting,
                    embeddings: ( model as any ).embeddings,
                    individualLimit: true,
                    models: ( model.models as any[] ).map( ( m ) => ( { model: m.model, rateLimit: m.rateLimit } ) )
                } as any;
                return transformed;
            }

            if ( model.individualLimit ) {
                const { rateLimit: _, ...rest } = model as any;
                return {
                    ...rest,
                    models: ( model.models as any[] ).map( ( m: string ) => ( {
                        model: m,
                        rateLimit: model.rateLimit
                    } ) )
                };
            }
            return model;
        } ) as any;
    }
}

export default MemoryCache;
