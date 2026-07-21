import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { isNonTextSpecializedConfig } from '@/core/routing/shared';
import { isDebugEnabled } from '@/utils/debug';

const PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
/** High concurrency limit so all probes start regardless of CPU core count. */
const PROBE_CONCURRENCY = 128;

type TextProviderConfig = {
    id: string;
    baseUrl: string;
    apiKey: string;
    models: Array<string | { model: string }>;
    stt?: boolean;
    tts?: boolean;
    embeddings?: boolean;
    imageModels?: unknown;
};

export type TextModelProbeResult = {
    providerId: string;
    model: string;
    healthy: boolean;
    successes: number;
    attempts: number;
    errors: string[];
    latencyMs: number;
};

let probeCompleted = false;
let probeSkipped = false;
/** Keys: `${providerId}::${modelName}` for text models that answered at least once. */
const healthyTextModels = new Set<string>();

export function isTextModelProbeCompleted(): boolean {
    return probeCompleted;
}

export function wasTextModelProbeSkipped(): boolean {
    return probeSkipped;
}

export function buildTextModelHealthKey( providerId: string, modelName: string ): string {
    return `${providerId}::${modelName}`;
}

/**
 * When the startup probe finished, only models that answered are healthy.
 * Before probe / when skipped, all models are treated as healthy (fail-open).
 */
export function isTextModelHealthy( providerId: string, modelName: string ): boolean {
    if ( !probeCompleted || probeSkipped ) {
        return true;
    }
    return healthyTextModels.has( buildTextModelHealthKey( providerId, modelName ) );
}

export function providerHasHealthyTextModel( config: { id: string; models: TextProviderConfig['models'] } ): boolean {
    if ( !probeCompleted || probeSkipped ) {
        return true;
    }
    return config.models.some( entry => {
        const modelName = typeof entry === 'string' ? entry : entry.model;
        return isTextModelHealthy( config.id, modelName );
    } );
}

export function getHealthyTextModelNames( config: { id: string; models: TextProviderConfig['models'] } ): string[] {
    return config.models
        .map( entry => ( typeof entry === 'string' ? entry : entry.model ) )
        .filter( modelName => isTextModelHealthy( config.id, modelName ) );
}

/**
 * Simple semaphore that guarantees all queued tasks start even when the
 * runtime would otherwise limit concurrency to CPU-core count.
 * Every call to `acquire()` eventually resolves — tasks are queued, not dropped.
 */
class ConcurrencyLimiter {
    private running = 0;
    private readonly queue: Array<() => void> = [];
    private readonly max: number;

    constructor( max: number ) {
        this.max = max;
    }

    async acquire(): Promise<void> {
        if ( this.running < this.max ) {
            this.running += 1;
            return;
        }
        await new Promise<void>( resolve => this.queue.push( resolve ) );
    }

    release(): void {
        this.running -= 1;
        const next = this.queue.shift();
        if ( next ) {
            this.running += 1;
            next();
        }
    }

    /** Run `fn` while holding a slot. */
    async run<T>( fn: () => Promise<T> ): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

function shouldSkipProbe(): boolean {
    if ( process.env.AI_EDGE_SKIP_MODEL_PROBE?.trim() === '1' ) {
        return true;
    }
    // bun test sets this; avoid network probes during unit tests
    if ( typeof ( globalThis as any ).Bun !== 'undefined' && ( globalThis as any ).Bun?.jest ) {
        return true;
    }
    if ( process.env.NODE_ENV === 'test' ) {
        return true;
    }
    return false;
}

function getProbeTimeoutMs(): number {
    const raw = process.env.AI_EDGE_MODEL_PROBE_TIMEOUT_MS?.trim();
    if ( !raw ) {
        return DEFAULT_PROBE_TIMEOUT_MS;
    }
    const parsed = Number.parseInt( raw, 10 );
    return Number.isFinite( parsed ) && parsed > 0 ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}

function chatCompletionsUrl( baseUrl: string ): string {
    const trimmed = baseUrl.replace( /\/+$/, '' );
    if ( /\/v1$/i.test( trimmed ) || /\/openai\/v1$/i.test( trimmed ) ) {
        return `${trimmed}/chat/completions`;
    }
    if ( /\/v1beta\/openai$/i.test( trimmed ) ) {
        return `${trimmed}/chat/completions`;
    }
    return `${trimmed}/chat/completions`;
}

async function probeOnce(
    config: TextProviderConfig,
    modelName: string,
    timeoutMs: number,
    proxyUrl?: string,
): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout( () => controller.abort(), timeoutMs );

    try {
        const response = await fetchWithProxy(
            chatCompletionsUrl( config.baseUrl ),
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                    'User-Agent': 'ai-edge/model-probe',
                },
                body: JSON.stringify( {
                    model: modelName,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                    stream: false,
                } ),
                signal: controller.signal,
            },
            proxyUrl,
            { skipTimeout: true },
        );

        const latencyMs = Date.now() - startedAt;
        if ( !response.ok ) {
            const bodyText = await response.text().catch( () => '' );
            const errMsg = `HTTP ${response.status}${bodyText ? `: ${bodyText.slice( 0, 180 )}` : ''}`;
            if ( isDebugEnabled() ) {
                console.error( `[startup] text_model_probe_err provider=${config.id} model=${modelName} ${errMsg} latencyMs=${latencyMs}` );
            }
            return { ok: false, error: errMsg, latencyMs };
        }

        const payload = await response.json().catch( () => null ) as any;
        const hasChoice = Array.isArray( payload?.choices ) && payload.choices.length > 0;
        const hasOutput = Array.isArray( payload?.output ) && payload.output.length > 0;
        if ( !hasChoice && !hasOutput && typeof payload?.id !== 'string' ) {
            const detail = isDebugEnabled() ? ` payload=${JSON.stringify( payload ).slice( 0, 300 )}` : '';
            if ( isDebugEnabled() ) {
                console.error( `[startup] text_model_probe_err provider=${config.id} model=${modelName} response missing choices/output${detail} latencyMs=${latencyMs}` );
            }
            return { ok: false, error: 'response missing choices/output', latencyMs };
        }

        return { ok: true, latencyMs };
    } catch ( error: any ) {
        const latencyMs = Date.now() - startedAt;
        const message = error?.name === 'AbortError'
            ? `timeout after ${timeoutMs}ms`
            : ( error?.message || String( error ) );
        if ( isDebugEnabled() ) {
            console.error( `[startup] text_model_probe_err provider=${config.id} model=${modelName} error=${message} latencyMs=${latencyMs}` );
        }
        return { ok: false, error: message, latencyMs };
    } finally {
        clearTimeout( timeoutId );
    }
}

/**
 * Probe every text (chat) model with PROBE_ATTEMPTS parallel requests.
 * A ConcurrencyLimiter (128 slots) guarantees every probe starts in-flight
 * regardless of CPU core count. After ALL attempts settle (Promise.all),
 * models with at least one success are marked healthy for text routing.
 * Image/STT/TTS/embeddings providers are skipped entirely.
 */
export async function probeAllTextModels( options?: {
    proxyUrl?: string;
    attempts?: number;
    timeoutMs?: number;
} ): Promise<TextModelProbeResult[]> {
    if ( shouldSkipProbe() ) {
        probeSkipped = true;
        probeCompleted = true;
        healthyTextModels.clear();
        console.info( '[startup] text_model_probe skipped (AI_EDGE_SKIP_MODEL_PROBE or test env)' );
        return [];
    }

    const attempts = options?.attempts ?? PROBE_ATTEMPTS;
    const timeoutMs = options?.timeoutMs ?? getProbeTimeoutMs();
    const proxyUrl = options?.proxyUrl ?? CONFIG.proxy;
    const configs = ( CONFIG.models.openai ?? [] ) as TextProviderConfig[];

    const targets: Array<{ config: TextProviderConfig; model: string }> = [];
    for ( const config of configs ) {
        if ( isNonTextSpecializedConfig( config ) ) {
            continue;
        }
        for ( const entry of config.models ) {
            const model = typeof entry === 'string' ? entry : entry.model;
            if ( model ) {
                targets.push( { config, model } );
            }
        }
    }

    if ( targets.length === 0 ) {
        probeCompleted = true;
        probeSkipped = false;
        healthyTextModels.clear();
        console.info( '[startup] text_model_probe no text models to probe' );
        return [];
    }

    const startedAt = Date.now();
    console.info(
        `[startup] text_model_probe starting targets=${targets.length} attemptsEach=${attempts} parallel=${targets.length * attempts}`
    );

    type AttemptOutcome = {
        providerId: string;
        model: string;
        ok: boolean;
        error?: string;
        latencyMs: number;
    };

    const attemptJobs: Array<Promise<AttemptOutcome>> = [];
    const limiter = new ConcurrencyLimiter( PROBE_CONCURRENCY );
    for ( const target of targets ) {
        for ( let i = 0; i < attempts; i += 1 ) {
            attemptJobs.push(
                limiter.run( () =>
                    probeOnce( target.config, target.model, timeoutMs, proxyUrl ).then( result => ( {
                        providerId: target.config.id,
                        model: target.model,
                        ok: result.ok,
                        error: result.error,
                        latencyMs: result.latencyMs,
                    } ) )
                )
            );
        }
    }

    const settled = await Promise.all( attemptJobs );

    const byKey = new Map<string, TextModelProbeResult>();
    for ( const target of targets ) {
        const key = buildTextModelHealthKey( target.config.id, target.model );
        byKey.set( key, {
            providerId: target.config.id,
            model: target.model,
            healthy: false,
            successes: 0,
            attempts,
            errors: [],
            latencyMs: 0,
        } );
    }

    for ( const outcome of settled ) {
        const key = buildTextModelHealthKey( outcome.providerId, outcome.model );
        const entry = byKey.get( key );
        if ( !entry ) {
            continue;
        }
        entry.latencyMs = Math.max( entry.latencyMs, outcome.latencyMs );
        if ( outcome.ok ) {
            entry.successes += 1;
            entry.healthy = true;
        } else if ( outcome.error && entry.errors.length < 3 ) {
            entry.errors.push( outcome.error );
        }
    }

    healthyTextModels.clear();
    const results = Array.from( byKey.values() );
    for ( const result of results ) {
        if ( result.healthy ) {
            healthyTextModels.add( buildTextModelHealthKey( result.providerId, result.model ) );
        }
        const status = result.healthy ? 'ok' : 'fail';
        const detail = result.healthy
            ? `successes=${result.successes}/${result.attempts}`
            : `errors=${result.errors[0] ?? 'unknown'}`;
        console.info(
            `[startup] text_model_probe ${status} provider=${result.providerId} model=${result.model} ${detail} latencyMs=${result.latencyMs}`
        );
    }

    probeCompleted = true;
    probeSkipped = false;

    const healthyCount = results.filter( r => r.healthy ).length;
    console.info(
        `[startup] text_model_probe complete healthy=${healthyCount}/${results.length} durationMs=${Date.now() - startedAt}`
    );

    return results;
}

/** Test helper: reset probe state without network. */
export function resetTextModelProbeStateForTests( options?: {
    completed?: boolean;
    skipped?: boolean;
    healthy?: Array<{ providerId: string; model: string }>;
} ): void {
    probeCompleted = options?.completed ?? false;
    probeSkipped = options?.skipped ?? false;
    healthyTextModels.clear();
    for ( const item of options?.healthy ?? [] ) {
        healthyTextModels.add( buildTextModelHealthKey( item.providerId, item.model ) );
    }
}
