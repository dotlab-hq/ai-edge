import { stripFreeModifier } from '@/utils/modelIds';
import { backendCooldownManager, type BackendCooldownManager } from './BackendCooldownManager';
import {
    type RoutingEndpoint,
    type RoutingProviderSnapshot,
    type RoutingSnapshot,
    type RoutingPoolOptions,
} from './RoutingSnapshot';
import {
    computeCandidateScore,
    computeHealthScore,
    compareCandidates,
    normalizeStartIndex,
    resolveLatencyEwmaMs,
    rotateList,
} from './routing/engineScoring';

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
