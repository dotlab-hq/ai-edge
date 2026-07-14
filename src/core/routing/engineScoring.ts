import type {
    RoutingCandidatePlanItem,
    RoutingProviderStatsInput,
} from '../RoutingEngine';

export const EXACT_MATCH_BONUS = 100;
export const SUCCESS_WEIGHT = 40;
export const FAILURE_WEIGHT = 55;
export const FAILURE_STREAK_PENALTY = 4;
export const MAX_STREAK_PENALTY = 20;
export const LATENCY_PENALTY_DIVISOR_MS = 250;
export const MAX_LATENCY_PENALTY = 30;
export const COOLDOWN_PENALTY = 1_000;
export const RATE_LIMIT_PENALTY = 750;

export function clamp( value: number, min: number, max: number ): number {
    if ( value < min ) {
        return min;
    }
    if ( value > max ) {
        return max;
    }
    return value;
}

export function computeHealthScore( stats: RoutingProviderStatsInput | undefined ): number {
    if ( !stats ) {
        return 0;
    }

    const successRate = clamp( stats.successRateEwma ?? 0.5, 0, 1 );
    const failureRate = clamp( stats.failureRateEwma ?? ( 1 - successRate ), 0, 1 );
    const consecutiveFailures = Math.max( 0, Math.floor( stats.consecutiveFailures ?? 0 ) );
    const streakPenalty = Math.min( MAX_STREAK_PENALTY, consecutiveFailures * FAILURE_STREAK_PENALTY );
    return successRate * SUCCESS_WEIGHT - failureRate * FAILURE_WEIGHT - streakPenalty;
}

export function resolveLatencyEwmaMs( stats: RoutingProviderStatsInput | undefined ): number | null {
    if ( !stats || typeof stats.latencyEwmaMs !== 'number' || !Number.isFinite( stats.latencyEwmaMs ) || stats.latencyEwmaMs < 0 ) {
        return null;
    }
    return stats.latencyEwmaMs;
}

export function computeCandidateScore( input: {
    providerMatch: 'exact' | 'fallback';
    healthScore: number;
    latencyEwmaMs: number | null;
    isOnCooldown: boolean;
    isRateLimited: boolean;
} ): number {
    const matchBonus = input.providerMatch === 'exact' ? EXACT_MATCH_BONUS : 0;
    const latencyPenalty = input.latencyEwmaMs === null
        ? 0
        : Math.min( MAX_LATENCY_PENALTY, Math.max( 0, input.latencyEwmaMs / LATENCY_PENALTY_DIVISOR_MS ) );
    const gatingPenalty = ( input.isOnCooldown ? COOLDOWN_PENALTY : 0 ) + ( input.isRateLimited ? RATE_LIMIT_PENALTY : 0 );

    return matchBonus + input.healthScore - latencyPenalty - gatingPenalty;
}

export function compareCandidates(
    left: Omit<RoutingCandidatePlanItem, 'rank'>,
    right: Omit<RoutingCandidatePlanItem, 'rank'>
): number {
    if ( left.isReady !== right.isReady ) {
        return left.isReady ? -1 : 1;
    }

    if ( left.score !== right.score ) {
        return right.score - left.score;
    }

    if ( left.providerMatch !== right.providerMatch ) {
        return left.providerMatch === 'exact' ? -1 : 1;
    }

    if ( left.baseRank !== right.baseRank ) {
        return left.baseRank - right.baseRank;
    }

    if ( left.provider.index !== right.provider.index ) {
        return left.provider.index - right.provider.index;
    }

    const modelComparison = left.model.localeCompare( right.model );
    if ( modelComparison !== 0 ) {
        return modelComparison;
    }

    return left.attemptKey.localeCompare( right.attemptKey );
}

export function normalizeStartIndex( startIndex: number | undefined, total: number, fallback: () => number ): number {
    if ( total <= 0 ) {
        return 0;
    }
    if ( typeof startIndex === 'number' && Number.isFinite( startIndex ) ) {
        const normalized = Math.floor( startIndex ) % total;
        return normalized >= 0 ? normalized : normalized + total;
    }
    return fallback();
}

export function rotateList<T>( items: readonly T[], startIndex: number ): readonly T[] {
    if ( !items.length || startIndex <= 0 ) {
        return items.slice();
    }
    return [...items.slice( startIndex ), ...items.slice( 0, startIndex )];
}
