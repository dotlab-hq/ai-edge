export type ProviderStatsSnapshot = Readonly<{
    providerId: string;
    modelName: string;
    sampleCount: number;
    successRateEwma: number;
    failureRateEwma: number;
    latencyEwmaMs: number | null;
    consecutiveFailures: number;
    lastUpdatedAt: number;
}>;

export type ProviderStatsTrackerOptions = Readonly<{
    alpha?: number;
}>;

type MutableProviderStats = {
    providerId: string;
    modelName: string;
    sampleCount: number;
    successRateEwma: number;
    failureRateEwma: number;
    latencyEwmaMs: number | null;
    consecutiveFailures: number;
    lastUpdatedAt: number;
};

const DEFAULT_ALPHA = 0.2;

export class ProviderStatsTracker {
    private readonly statsByKey = new Map<string, MutableProviderStats>();
    private readonly alpha: number;

    constructor( options: ProviderStatsTrackerOptions = {} ) {
        const alpha = typeof options.alpha === 'number' && Number.isFinite( options.alpha )
            ? options.alpha
            : DEFAULT_ALPHA;
        this.alpha = clamp( alpha, 0.01, 1 );
    }

    recordSuccess( providerId: string, modelName: string, latencyMs?: number ): ProviderStatsSnapshot {
        return this.recordEvent( providerId, modelName, true, latencyMs );
    }

    recordFailure( providerId: string, modelName: string, latencyMs?: number ): ProviderStatsSnapshot {
        return this.recordEvent( providerId, modelName, false, latencyMs );
    }

    getStats( providerId: string, modelName: string ): ProviderStatsSnapshot | undefined {
        const record = this.statsByKey.get( buildKey( providerId, modelName ) );
        return record ? freezeSnapshot( record ) : undefined;
    }

    clear(): void {
        this.statsByKey.clear();
    }

    private recordEvent( providerId: string, modelName: string, isSuccess: boolean, latencyMs?: number ): ProviderStatsSnapshot {
        const key = buildKey( providerId, modelName );
        const existing = this.statsByKey.get( key ) ?? createInitialRecord( providerId, modelName );

        existing.sampleCount += 1;
        existing.successRateEwma = ewma( existing.successRateEwma, isSuccess ? 1 : 0, this.alpha );
        existing.failureRateEwma = ewma( existing.failureRateEwma, isSuccess ? 0 : 1, this.alpha );
        existing.consecutiveFailures = isSuccess ? 0 : existing.consecutiveFailures + 1;
        existing.lastUpdatedAt = Date.now();

        if ( typeof latencyMs === 'number' && Number.isFinite( latencyMs ) && latencyMs >= 0 ) {
            existing.latencyEwmaMs = existing.latencyEwmaMs === null
                ? latencyMs
                : ewma( existing.latencyEwmaMs, latencyMs, this.alpha );
        }

        this.statsByKey.set( key, existing );
        return freezeSnapshot( existing );
    }
}

function createInitialRecord( providerId: string, modelName: string ): MutableProviderStats {
    return {
        providerId,
        modelName,
        sampleCount: 0,
        successRateEwma: 1,
        failureRateEwma: 0,
        latencyEwmaMs: null,
        consecutiveFailures: 0,
        lastUpdatedAt: Date.now(),
    };
}

function buildKey( providerId: string, modelName: string ): string {
    return `${providerId}::${modelName}`;
}

function ewma( current: number, sample: number, alpha: number ): number {
    return current + alpha * ( sample - current );
}

function clamp( value: number, min: number, max: number ): number {
    if ( value < min ) {
        return min;
    }
    if ( value > max ) {
        return max;
    }
    return value;
}

function freezeSnapshot( stats: MutableProviderStats ): ProviderStatsSnapshot {
    return Object.freeze( {
        providerId: stats.providerId,
        modelName: stats.modelName,
        sampleCount: stats.sampleCount,
        successRateEwma: stats.successRateEwma,
        failureRateEwma: stats.failureRateEwma,
        latencyEwmaMs: stats.latencyEwmaMs,
        consecutiveFailures: stats.consecutiveFailures,
        lastUpdatedAt: stats.lastUpdatedAt,
    } );
}
