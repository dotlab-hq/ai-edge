import type { Config } from '@/schema';

export type RateLimit = Partial<NonNullable<Config['rateLimit']>>;

export interface BucketRecord {
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
