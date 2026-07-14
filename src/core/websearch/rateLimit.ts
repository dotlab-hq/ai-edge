import type { BucketRecord, WebSearchToolConfig } from './types';
import { CACHE } from '../../state';
import { buildRateLimitKey, currentUtcDayWindowStart, currentUtcMonthWindowStart, refreshBucketRecord } from './utils';

export async function consumeRateLimit(tool: WebSearchToolConfig): Promise<void> {
    const limit = tool.rateLimit;
    if (!limit) {
        return;
    }

    const key = buildRateLimitKey(tool);
    const record = refreshBucketRecord(await getBucket(tool), new Date());
    const minuteLimit = limit.requestsPerMinute;
    const dayLimit = limit.requestsPerDay;
    const monthLimit = limit.requestsPerMonth;

    if (typeof minuteLimit === 'number' && record.minuteUsed + 1 > minuteLimit) {
        throw new Error(`Web search rate limit exceeded for ${tool.type} (minute)`);
    }
    if (typeof dayLimit === 'number' && record.dailyRequests + 1 > dayLimit) {
        throw new Error(`Web search rate limit exceeded for ${tool.type} (day)`);
    }
    if (typeof monthLimit === 'number' && record.monthlyRequests + 1 > monthLimit) {
        throw new Error(`Web search rate limit exceeded for ${tool.type} (month)`);
    }

    record.minuteUsed += 1;
    record.dailyRequests += 1;
    record.monthlyRequests += 1;
    await CACHE.setKey(key, record);
}

export async function getBucket(tool: WebSearchToolConfig): Promise<BucketRecord> {
    const key = buildRateLimitKey(tool);
    const existing = await CACHE.getKey<BucketRecord>(key);
    if (existing) {
        return existing;
    }

    const now = new Date();
    const initial: BucketRecord = {
        minuteUsed: 0,
        minuteWindowStart: Math.floor(now.getTime() / 60000) * 60000,
        dailyRequests: 0,
        dayWindowStart: currentUtcDayWindowStart(now),
        monthlyRequests: 0,
        monthWindowStart: currentUtcMonthWindowStart(now),
    };
    await CACHE.setKey(key, initial);
    return initial;
}
