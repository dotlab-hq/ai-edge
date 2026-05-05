import { CACHE } from "../state";
import type { Config } from "@/schema";

type RateLimit = Partial<NonNullable<Config['rateLimit']>>;

interface BucketRecord {
    tokens: number;
    lastRefill: number;
    dailyRequests: number;
    dayStart: number;
}

export class RateLimitManager {
    private readonly keyPrefix = 'rate_limit:';
    private readonly locks = new Map<string, { promise: Promise<void>; resolve: () => void }>();

    async checkAndConsume(
        modelId: string,
        tokens: number,
        rateLimit: RateLimit | undefined
    ): Promise<{ allowed: boolean; reason?: string }> {
        // No rateLimit object at all => unlimited
        if ( !rateLimit ) {
            return { allowed: true };
        }

        const hasRequestsPerMinute = typeof rateLimit.requestsPerMinute === 'number';
        const hasRequestsPerDay = typeof rateLimit.requestsPerDay === 'number';

        // If neither limit is specified, treat as unlimited
        if ( !hasRequestsPerMinute && !hasRequestsPerDay ) {
            return { allowed: true };
        }

        const key = `${this.keyPrefix}${modelId}`;

        const release = await this.acquireLock( key );

        try {
            const record = await this.getOrCreateBucket( key );
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;

            const currentDayStart = Math.floor( now / oneDay ) * oneDay;
            if ( record.dayStart !== currentDayStart ) {
                record.dailyRequests = 0;
                record.dayStart = currentDayStart;
            }

            // Enforce daily limit only if provided
            if ( hasRequestsPerDay && ( record.dailyRequests + 1 > ( rateLimit.requestsPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily request limit exceeded' };
            }

            // If no requests-per-minute provided, skip token-bucket checks and allow (daily check was above)
            if ( !hasRequestsPerMinute ) {
                record.dailyRequests += 1;
                await CACHE.setKey( key, record );
                return { allowed: true };
            }

            // Token-bucket using provided requestsPerMinute
            const rpm = rateLimit.requestsPerMinute as number;
            const tokensPerSecond = rpm / 60;
            const refillAmount = ( now - record.lastRefill ) / 1000 * tokensPerSecond;
            record.tokens = Math.min( rpm, record.tokens + refillAmount );
            record.lastRefill = now;

            if ( record.tokens >= tokens ) {
                record.tokens -= tokens;
                if ( hasRequestsPerDay ) record.dailyRequests += 1;
                await CACHE.setKey( key, record );
                return { allowed: true };
            }

            return { allowed: false, reason: 'Rate limit exceeded' };
        } finally {
            release();
        }
    }

    private async acquireLock( lockKey: string ): Promise<() => void> {
        while ( this.locks.has( lockKey ) ) {
            const existing = this.locks.get( lockKey )!;
            await existing.promise;
        }

        let resolveFn: () => void;
        const promise = new Promise<void>( resolve => { resolveFn = resolve; } );
        this.locks.set( lockKey, { promise, resolve: resolveFn! } );

        return () => {
            resolveFn!();
            this.locks.delete( lockKey );
        };
    }

    private async getOrCreateBucket( key: string ): Promise<BucketRecord> {
        const record = await CACHE.getKey<BucketRecord>( key );
        if ( !record ) {
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;
            const newRecord = {
                // default tokens is a reasonable cap for new buckets; actual enforcement
                // will depend on whether a provider supplies requestsPerMinute.
                tokens: 150,
                lastRefill: now,
                dailyRequests: 0,
                dayStart: Math.floor( now / oneDay ) * oneDay
            };
            await CACHE.setKey( key, newRecord );
            return newRecord;
        }
        return record;
    }

    async getUsage( modelId: string ): Promise<{ requestsUsed: number; dailyRequests: number } | null> {
        const key = `${this.keyPrefix}${modelId}`;
        const record = await CACHE.getKey<BucketRecord>( key );
        return record ? {
            requestsUsed: Math.ceil( record.tokens ),
            dailyRequests: record.dailyRequests
        } : null;
    }

    async reset( modelId: string ): Promise<void> {
        const key = `${this.keyPrefix}${modelId}`;
        await CACHE.setKey( key, this.emptyBucket() );
    }

    private emptyBucket(): BucketRecord {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        return {
            tokens: 0,
            lastRefill: now,
            dailyRequests: 0,
            dayStart: Math.floor( now / oneDay ) * oneDay
        };
    }
}

export const rateLimitManager = new RateLimitManager();