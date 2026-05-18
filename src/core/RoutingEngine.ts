import { stripFreeModifier } from '@/utils/modelIds';
import { backendCooldownManager, type BackendCooldownManager } from './BackendCooldownManager';
import {
    type RoutingEndpoint,
    type RoutingProviderSnapshot,
    type RoutingSnapshot,
    type RoutingPoolOptions,
} from './RoutingSnapshot';

export type RoutingCooldownLookup = ( providerId: string, modelName: string ) => number;

export type RoutingRateLimitPrecheckResult = boolean | Readonly<{
    allowed: boolean;
    retryAfterMs?: number;
}>;

export type RoutingProviderStatsInput = Readonly<{
    successRateEwma?: number;
    failureRateEwma?: number;
    latencyEwmaMs?: number;
    consecutiveFailures?: number;
}>;

export type RoutingEngineHooks = Readonly<{
    getCooldownRemainingMs?: RoutingCooldownLookup;
    cooldownManager?: Pick<BackendCooldownManager, 'getRemainingMs'>;
    precheckRateLimit?: (
        provider: RoutingProviderSnapshot,
        modelName: string,
        request: RoutingPlanRequest
    ) => RoutingRateLimitPrecheckResult | undefined;
    getProviderStats?: ( providerId: string, modelName: string ) => RoutingProviderStatsInput | undefined;
}>;

export type RoutingPlanRequest = Readonly<{
    requestedModel: string;
    endpoint: RoutingEndpoint;
    includeFallback?: boolean;
    honorRandomRouting?: boolean;
    providerStartIndex?: number;
    randomizeProviderOrder?: boolean;
    randomizeModelOrder?: boolean;
    modelStartIndexByProvider?: Readonly<Record<string, number>>;
}>;

export type RoutingCandidatePlanItem = Readonly<{
    rank: number;
    baseRank: number;
    score: number;
    healthScore: number;
    latencyEwmaMs: number | null;
    attemptKey: string;
    providerId: string;
    provider: RoutingProviderSnapshot;
    model: string;
    providerMatch: 'exact' | 'fallback';
    cooldownRemainingMs: number;
    isOnCooldown: boolean;
    rateLimitRetryAfterMs: number;
    isRateLimited: boolean;
    isReady: boolean;
}>;

export type RoutingCandidatePlan = Readonly<{
    requestedModel: string;
    normalizedRequestedModel: string;
    endpoint: RoutingEndpoint;
    includeFallback: boolean;
    honorRandomRouting: boolean;
    exactProviderCount: number;
    fallbackProviderCount: number;
    candidates: readonly RoutingCandidatePlanItem[];
    readyCandidates: readonly RoutingCandidatePlanItem[];
}>;

export class RoutingEngine {
    constructor(
        private snapshot: RoutingSnapshot,
        private readonly hooks: RoutingEngineHooks = {},
        private readonly random: () => number = Math.random
    ) { }

    getSnapshot(): RoutingSnapshot {
        return this.snapshot;
    }

    setSnapshot( snapshot: RoutingSnapshot ): void {
        this.snapshot = snapshot;
    }

    buildCandidatePlan( request: RoutingPlanRequest ): RoutingCandidatePlan {
        const poolOptions: RoutingPoolOptions = {
            includeFallback: request.includeFallback,
            honorRandomRouting: request.honorRandomRouting,
        };
        const providerPool = this.snapshot.getProviderPool( request.requestedModel, request.endpoint, poolOptions );

        const providers = this.getOrderedProviders(
            providerPool.providers,
            request.providerStartIndex,
            request.randomizeProviderOrder === true
        );
        const exactProviderIds = new Set( providerPool.exactProviders.map( provider => provider.id ) );

        const candidateInputs: Array<Omit<RoutingCandidatePlanItem, 'rank'>> = [];
        let baseRank = 1;
        for ( const provider of providers ) {
            const modelCandidates = this.snapshot.getCandidateModelsForProvider(
                provider,
                request.requestedModel,
                {
                    honorRandomRouting: providerPool.honorRandomRouting,
                    randomize: request.randomizeModelOrder !== false,
                    startIndex: request.modelStartIndexByProvider?.[provider.id],
                    random: this.random,
                }
            );

            const providerMatch = exactProviderIds.has( provider.id ) ? 'exact' : 'fallback';
            for ( const model of modelCandidates ) {
                const cooldownRemainingMs = this.getCooldownRemainingMs( provider.id, model );
                const rateLimitState = this.getRateLimitState( provider, model, request );
                const stats = this.hooks.getProviderStats?.( provider.id, model );
                const healthScore = computeHealthScore( stats );
                const latencyEwmaMs = resolveLatencyEwmaMs( stats );
                const score = computeCandidateScore( {
                    providerMatch,
                    healthScore,
                    latencyEwmaMs,
                    isOnCooldown: cooldownRemainingMs > 0,
                    isRateLimited: rateLimitState.isRateLimited,
                } );

                candidateInputs.push( {
                    baseRank,
                    score,
                    healthScore,
                    latencyEwmaMs,
                    attemptKey: `${provider.id}::${model}`,
                    providerId: provider.id,
                    provider,
                    model,
                    providerMatch,
                    cooldownRemainingMs,
                    isOnCooldown: cooldownRemainingMs > 0,
                    rateLimitRetryAfterMs: rateLimitState.retryAfterMs,
                    isRateLimited: rateLimitState.isRateLimited,
                    isReady: cooldownRemainingMs <= 0 && !rateLimitState.isRateLimited,
                } );
                baseRank += 1;
            }
        }

        candidateInputs.sort( compareCandidates );
        const candidates: RoutingCandidatePlanItem[] = candidateInputs.map( ( candidate, index ) => Object.freeze( {
            rank: index + 1,
            ...candidate,
        } ) );
        const readyCandidates = candidates.filter( candidate => candidate.isReady );

        return Object.freeze( {
            requestedModel: request.requestedModel,
            normalizedRequestedModel: stripFreeModifier( request.requestedModel ).normalizedId,
            endpoint: request.endpoint,
            includeFallback: providerPool.includeFallback,
            honorRandomRouting: providerPool.honorRandomRouting,
            exactProviderCount: providerPool.exactProviders.length,
            fallbackProviderCount: providerPool.fallbackProviders.length,
            candidates: Object.freeze( candidates ),
            readyCandidates: Object.freeze( readyCandidates ),
        } );
    }

    private getCooldownRemainingMs( providerId: string, modelName: string ): number {
        const hookValue = this.hooks.getCooldownRemainingMs?.( providerId, modelName );
        if ( typeof hookValue === 'number' && Number.isFinite( hookValue ) ) {
            return Math.max( 0, hookValue );
        }

        const manager = this.hooks.cooldownManager ?? backendCooldownManager;
        return Math.max( 0, manager.getRemainingMs( providerId, modelName ) );
    }

    private getRateLimitState(
        provider: RoutingProviderSnapshot,
        modelName: string,
        request: RoutingPlanRequest
    ): { isRateLimited: boolean; retryAfterMs: number } {
        const precheckResult = this.hooks.precheckRateLimit?.( provider, modelName, request );
        if ( typeof precheckResult === 'undefined' ) {
            return { isRateLimited: false, retryAfterMs: 0 };
        }
        if ( typeof precheckResult === 'boolean' ) {
            return { isRateLimited: !precheckResult, retryAfterMs: 0 };
        }

        return {
            isRateLimited: precheckResult.allowed === false,
            retryAfterMs: Math.max( 0, precheckResult.retryAfterMs ?? 0 ),
        };
    }

    private getOrderedProviders(
        providers: readonly RoutingProviderSnapshot[],
        providerStartIndex: number | undefined,
        randomize: boolean
    ): readonly RoutingProviderSnapshot[] {
        if ( providers.length <= 1 ) {
            return providers;
        }

        const startIndex = normalizeStartIndex(
            providerStartIndex,
            providers.length,
            () => randomize ? Math.floor( this.random() * providers.length ) : 0
        );
        return rotateList( providers, startIndex );
    }
}

const EXACT_MATCH_BONUS = 100;
const SUCCESS_WEIGHT = 40;
const FAILURE_WEIGHT = 55;
const FAILURE_STREAK_PENALTY = 4;
const MAX_STREAK_PENALTY = 20;
const LATENCY_PENALTY_DIVISOR_MS = 250;
const MAX_LATENCY_PENALTY = 30;
const COOLDOWN_PENALTY = 1_000;
const RATE_LIMIT_PENALTY = 750;

function computeHealthScore( stats: RoutingProviderStatsInput | undefined ): number {
    if ( !stats ) {
        return 0;
    }

    const successRate = clamp( stats.successRateEwma ?? 0.5, 0, 1 );
    const failureRate = clamp( stats.failureRateEwma ?? ( 1 - successRate ), 0, 1 );
    const consecutiveFailures = Math.max( 0, Math.floor( stats.consecutiveFailures ?? 0 ) );
    const streakPenalty = Math.min( MAX_STREAK_PENALTY, consecutiveFailures * FAILURE_STREAK_PENALTY );
    return successRate * SUCCESS_WEIGHT - failureRate * FAILURE_WEIGHT - streakPenalty;
}

function resolveLatencyEwmaMs( stats: RoutingProviderStatsInput | undefined ): number | null {
    if ( !stats || typeof stats.latencyEwmaMs !== 'number' || !Number.isFinite( stats.latencyEwmaMs ) || stats.latencyEwmaMs < 0 ) {
        return null;
    }
    return stats.latencyEwmaMs;
}

function computeCandidateScore( input: {
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

function compareCandidates(
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

function normalizeStartIndex( startIndex: number | undefined, total: number, fallback: () => number ): number {
    if ( total <= 0 ) {
        return 0;
    }
    if ( typeof startIndex === 'number' && Number.isFinite( startIndex ) ) {
        const normalized = Math.floor( startIndex ) % total;
        return normalized >= 0 ? normalized : normalized + total;
    }
    return fallback();
}

function rotateList<T>( items: readonly T[], startIndex: number ): readonly T[] {
    if ( !items.length || startIndex <= 0 ) {
        return items.slice();
    }
    return [...items.slice( startIndex ), ...items.slice( 0, startIndex )];
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
