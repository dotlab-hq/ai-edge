import { CACHE } from "../state";
import type { Config } from "@/schema";

type RateLimit = Partial<NonNullable<Config['rateLimit']>>;

interface BucketRecord {
    tokens: number;
    lastRefill: number;
    dailyRequests: number;
    dayStart: number;
    audioSecondsThisHour: number;
    hourStart: number;
    audioSecondsToday: number;
    audioDayStart: number;
    tokensToday: number;
    tokenDayStart: number;
}

export class RateLimitManager {
    private readonly keyPrefix = 'rate_limit:';
    private readonly locks = new Map<string, { promise: Promise<void>; resolve: () => void; expires: number }>();
    private static readonly LOCK_TIMEOUT_MS = 5000; // 5 second timeout for locks

    async checkAndConsume(
        providerId: string,
        tokens: number,
        rateLimit: RateLimit | undefined,
        modelName?: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        // No rateLimit object at all => unlimited
        if ( !rateLimit ) {
            return { allowed: true };
        }

        const hasTokensPerMinute = typeof rateLimit.tokensPerMinute === 'number';
        const hasRequestsPerMinute = typeof rateLimit.requestsPerMinute === 'number';
        const hasRequestsPerDay = typeof rateLimit.requestsPerDay === 'number';
        const hasTokensPerDay = typeof rateLimit.tokensPerDay === 'number';

        // If no limits specified, treat as unlimited
        if ( !hasTokensPerMinute && !hasRequestsPerMinute && !hasRequestsPerDay && !hasTokensPerDay ) {
            return { allowed: true };
        }

        const key = modelName ? `${this.keyPrefix}${providerId}:${modelName}` : `${this.keyPrefix}${providerId}`;

        const release = await this.acquireLock( key );

        try {
            const record = await this.getOrCreateBucket( key, rateLimit );
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

            // Enforce daily token limit only if provided
            if ( hasTokensPerDay && ( record.tokensToday + tokens > ( rateLimit.tokensPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily token limit exceeded' };
            }

            // Token-bucket algorithm using tokensPerMinute if available, otherwise requestsPerMinute
            const tokenLimit: number = hasTokensPerMinute
                ? ( rateLimit.tokensPerMinute as number )
                : ( hasRequestsPerMinute ? ( rateLimit.requestsPerMinute as number ) : 0 );

            if ( tokenLimit > 0 ) {
                const tokensPerSecond = tokenLimit / 60;
                const refillAmount = ( now - record.lastRefill ) / 1000 * tokensPerSecond;
                record.tokens = Math.min( tokenLimit, record.tokens + refillAmount );
                record.lastRefill = now;

                if ( record.tokens >= tokens ) {
                    record.tokens -= tokens;
                    if ( hasRequestsPerDay ) record.dailyRequests += 1;
                    record.tokensToday += tokens;
                    await CACHE.setKey( key, record );
                    return { allowed: true };
                }

                return { allowed: false, reason: 'Rate limit exceeded' };
            }

            // No token-based limit, just track daily
            if ( hasRequestsPerDay ) {
                record.dailyRequests += 1;
            }
            record.tokensToday += tokens;
            await CACHE.setKey( key, record );
            return { allowed: true };
        } finally {
            release();
        }
    }

    private async acquireLock( lockKey: string ): Promise<() => void> {
        // Clean up expired locks first
        this.cleanupExpiredLocks();

        while ( true ) {
            const existing = this.locks.get( lockKey );
            if ( !existing ) {
                // No lock exists, try to create one
                let resolveFn: () => void;
                const promise = new Promise<void>( resolve => { resolveFn = resolve; } );
                const expires = Date.now() + RateLimitManager.LOCK_TIMEOUT_MS;

                // Use a map operation that is atomic for checking and setting
                if ( !this.locks.has( lockKey ) ) {
                    this.locks.set( lockKey, { promise, resolve: resolveFn!, expires } );

                    return () => {
                        resolveFn!();
                        this.locks.delete( lockKey );
                    };
                }
                // If we get here, another process created the lock while we were setting up
                // Continue the loop to wait for it
                continue;
            }

            // Lock exists, wait for it to be released or timeout
            try {
                await Promise.race( [
                    existing.promise,
                    this.timeoutPromise( existing.expires - Date.now() )
                ] );
                // After waiting, clean up expired locks again and retry
                this.cleanupExpiredLocks();
            } catch ( err ) {
                // Timeout occurred, remove the expired lock and retry
                this.locks.delete( lockKey );
                this.cleanupExpiredLocks();
            }
        }
    }

    private timeoutPromise( ms: number ): Promise<never> {
        return new Promise( ( _, reject ) => {
            setTimeout( () => reject( new Error( 'Lock timeout' ) ), ms );
        } );
    }

    private cleanupExpiredLocks(): void {
        const now = Date.now();
        for ( const [key, lock] of this.locks.entries() ) {
            if ( now > lock.expires ) {
                this.locks.delete( key );
                // Resolve the promise to prevent waiting forever
                lock.resolve();
            }
        }
    }

    private async getOrCreateBucket( key: string, rateLimit?: RateLimit ): Promise<BucketRecord> {
        const record = await CACHE.getKey<BucketRecord>( key );
        if ( !record ) {
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;
            const oneHour = 60 * 60 * 1000;
            // Initialize tokens based on tokensPerMinute if available, otherwise requestsPerMinute
            let initialTokens = 1000; // default fallback
            if ( rateLimit ) {
                if ( typeof rateLimit.tokensPerMinute === 'number' ) {
                    initialTokens = rateLimit.tokensPerMinute;
                } else if ( typeof rateLimit.requestsPerMinute === 'number' ) {
                    initialTokens = rateLimit.requestsPerMinute;
                }
            }
            const newRecord = {
                tokens: initialTokens,
                lastRefill: now,
                dailyRequests: 0,
                dayStart: Math.floor( now / oneDay ) * oneDay,
                audioSecondsThisHour: 0,
                hourStart: Math.floor( now / oneHour ) * oneHour,
                audioSecondsToday: 0,
                audioDayStart: Math.floor( now / oneDay ) * oneDay,
                tokensToday: 0,
                tokenDayStart: Math.floor( now / oneDay ) * oneDay
            };
            await CACHE.setKey( key, newRecord );
            return newRecord;
        }
        return record;
    }

    /**
     * Check and consume audio seconds for STT providers.
     * @param providerId - The provider identifier
     * @param audioSeconds - Number of seconds of audio to transcribe
     * @param rateLimit - The unified rate limit configuration (reads audioSecondsPerHour/audioSecondsPerDay)
     * @param modelName - Optional model name for per-model tracking
     */
    async checkAndConsumeAudioSeconds(
        providerId: string,
        audioSeconds: number,
        rateLimit: RateLimit | undefined,
        modelName?: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        if ( !rateLimit ) {
            return { allowed: true };
        }

        const hasAudioSecondsPerHour = typeof rateLimit.audioSecondsPerHour === 'number';
        const hasAudioSecondsPerDay = typeof rateLimit.audioSecondsPerDay === 'number';
        const hasRequestsPerMinute = typeof rateLimit.requestsPerMinute === 'number';
        const hasRequestsPerDay = typeof rateLimit.requestsPerDay === 'number';

        if ( !hasAudioSecondsPerHour && !hasAudioSecondsPerDay && !hasRequestsPerMinute && !hasRequestsPerDay ) {
            return { allowed: true };
        }

        const key = `${this.keyPrefix}stt:${providerId}${modelName ? ':' + modelName : ''}`;

        const release = await this.acquireLock( key );

        try {
            const record = await this.getOrCreateBucket( key );
            const now = Date.now();
            const oneHour = 60 * 60 * 1000;
            const oneDay = 24 * 60 * 60 * 1000;

            // Reset hourly audio counter if needed
            const currentHourStart = Math.floor( now / oneHour ) * oneHour;
            if ( record.hourStart !== currentHourStart ) {
                record.audioSecondsThisHour = 0;
                record.hourStart = currentHourStart;
            }

            // Reset daily audio counter if needed
            const currentDayStart = Math.floor( now / oneDay ) * oneDay;
            if ( record.audioDayStart !== currentDayStart ) {
                record.audioSecondsToday = 0;
                record.dailyRequests = 0;
                record.audioDayStart = currentDayStart;
                record.dayStart = currentDayStart;
            }

            // Check daily request limit
            if ( hasRequestsPerDay && ( record.dailyRequests + 1 > ( rateLimit.requestsPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily STT request limit exceeded' };
            }

            // Check daily audio seconds limit
            if ( hasAudioSecondsPerDay && ( record.audioSecondsToday + audioSeconds > ( rateLimit.audioSecondsPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily audio seconds limit exceeded' };
            }

            // Check hourly audio seconds limit
            if ( hasAudioSecondsPerHour && ( record.audioSecondsThisHour + audioSeconds > ( rateLimit.audioSecondsPerHour as number ) ) ) {
                return { allowed: false, reason: 'Hourly audio seconds limit exceeded' };
            }

            // Check per-minute request limit (token bucket style)
            if ( hasRequestsPerMinute ) {
                const tokenLimit = rateLimit.requestsPerMinute as number;
                const tokensPerSecond = tokenLimit / 60;
                const refillAmount = ( now - record.lastRefill ) / 1000 * tokensPerSecond;
                record.tokens = Math.min( tokenLimit, record.tokens + refillAmount );
                record.lastRefill = now;

                if ( record.tokens < 1 ) {
                    return { allowed: false, reason: 'STT rate limit exceeded (requests per minute)' };
                }
                record.tokens -= 1;
            }

            // All checks passed — consume
            record.audioSecondsThisHour += audioSeconds;
            record.audioSecondsToday += audioSeconds;
            if ( hasRequestsPerDay ) record.dailyRequests += 1;

            await CACHE.setKey( key, record );
            return { allowed: true };
        } finally {
            release();
        }
    }

    /**
     * Check and consume tokens for TTS providers using tokensPerDay limit.
     * @param providerId - The provider identifier
     * @param characters - Number of characters (treated as tokens for daily limit)
     * @param rateLimit - The unified rate limit configuration (reads tokensPerDay)
     * @param modelName - Optional model name for per-model tracking
     */
    async checkAndConsumeTTSCharacters(
        providerId: string,
        characters: number,
        rateLimit: RateLimit | undefined,
        modelName?: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        if ( !rateLimit ) {
            return { allowed: true };
        }

        const hasTokensPerDay = typeof rateLimit.tokensPerDay === 'number';

        if ( !hasTokensPerDay ) {
            return { allowed: true };
        }

        const key = `${this.keyPrefix}tts:${providerId}${modelName ? ':' + modelName : ''}`;

        const release = await this.acquireLock( key );

        try {
            const record = await this.getOrCreateBucket( key );
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;

            // Reset daily token counter if needed
            const currentDayStart = Math.floor( now / oneDay ) * oneDay;
            if ( record.tokenDayStart !== currentDayStart ) {
                record.tokensToday = 0;
                record.tokenDayStart = currentDayStart;
            }

            // Check per-day token limit
            if ( hasTokensPerDay && ( record.tokensToday + characters > ( rateLimit.tokensPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily TTS token limit exceeded' };
            }

            // All checks passed — consume
            record.tokensToday += characters;

            await CACHE.setKey( key, record );
            return { allowed: true };
        } finally {
            release();
        }
    }

    async getUsage( providerId: string, modelName?: string ): Promise<{ tokensRemaining: number; dailyRequests: number; audioSecondsThisHour: number; audioSecondsToday: number; tokensToday: number } | null> {
        const key = modelName ? `${this.keyPrefix}${providerId}:${modelName}` : `${this.keyPrefix}${providerId}`;
        const record = await CACHE.getKey<BucketRecord>( key );
        return record ? {
            tokensRemaining: Math.ceil( record.tokens ),
            dailyRequests: record.dailyRequests,
            audioSecondsThisHour: record.audioSecondsThisHour,
            audioSecondsToday: record.audioSecondsToday,
            tokensToday: record.tokensToday
        } : null;
    }

    async reset( providerId: string, modelName?: string ): Promise<void> {
        const key = modelName ? `${this.keyPrefix}${providerId}:${modelName}` : `${this.keyPrefix}${providerId}`;
        await CACHE.setKey( key, this.emptyBucket() );
    }

    private emptyBucket(): BucketRecord {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const oneHour = 60 * 60 * 1000;
        return {
            tokens: 0,
            lastRefill: now,
            dailyRequests: 0,
            dayStart: Math.floor( now / oneDay ) * oneDay,
            audioSecondsThisHour: 0,
            hourStart: Math.floor( now / oneHour ) * oneHour,
            audioSecondsToday: 0,
            audioDayStart: Math.floor( now / oneDay ) * oneDay,
            tokensToday: 0,
            tokenDayStart: Math.floor( now / oneDay ) * oneDay
        };
    }
}

export const rateLimitManager = new RateLimitManager();