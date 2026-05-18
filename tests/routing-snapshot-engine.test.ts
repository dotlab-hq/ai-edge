import { expect, test } from 'bun:test';
import { BackendCooldownManager } from '../src/core/BackendCooldownManager';
import { ProviderStatsTracker } from '../src/core/ProviderStatsTracker';
import { RoutingEngine } from '../src/core/RoutingEngine';
import { RoutingSnapshot, RoutingSnapshotStore } from '../src/core/RoutingSnapshot';

function buildProviderConfig( id: string, models: string[], overrides: Record<string, unknown> = {} ): any {
  return {
    id,
    name: id,
    models,
    individualLimit: false,
    randomRouting: true,
    embeddings: false,
    imageModels: false,
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    ...overrides,
  };
}

test( 'RoutingSnapshot compiles endpoint capabilities and normalized model lookups', () => {
  const snapshot = RoutingSnapshot.compile( [
    buildProviderConfig( 'text-provider', ['gpt-4.1', 'gpt-4o-mini'] ),
    buildProviderConfig( 'embeddings-provider', ['text-embedding-3-large'], {
      embeddings: true,
    } ),
    buildProviderConfig( 'image-provider', ['gpt-image-1'], {
      imageModels: { image_generation: true },
    } ),
  ] as any );

  const chatPool = snapshot.getProviderPool( 'free:gpt-4.1', 'chat/completions' );
  expect( chatPool.exactProviders.map( provider => provider.id ) ).toEqual( ['text-provider'] );

  const embeddingsPool = snapshot.getProviderPool( 'unknown', 'embeddings' );
  expect( embeddingsPool.providers.map( provider => provider.id ) ).toEqual( ['embeddings-provider'] );

  const imagePool = snapshot.getProviderPool( 'unknown', 'images/generations' );
  expect( imagePool.providers.map( provider => provider.id ) ).toEqual( ['image-provider'] );

  const candidateModels = snapshot.getCandidateModelsForProvider( 'text-provider', 'gpt-4.1:free' );
  expect( candidateModels ).toEqual( ['gpt-4.1:free'] );
} );

test( 'RoutingSnapshot provider pool honors includeFallback and randomRouting settings', () => {
  const snapshot = RoutingSnapshot.compile( [
    buildProviderConfig( 'exact-provider', ['gpt-4.1'], {
      randomRouting: false,
    } ),
    buildProviderConfig( 'fallback-enabled', ['gpt-4o-mini'], {
      randomRouting: true,
    } ),
    buildProviderConfig( 'fallback-disabled', ['gpt-3.5-turbo'], {
      randomRouting: false,
    } ),
  ] as any );

  const strictPool = snapshot.getProviderPool( 'gpt-4.1', 'chat/completions', {
    includeFallback: true,
    honorRandomRouting: true,
  } );
  expect( strictPool.providers.map( provider => provider.id ) ).toEqual( ['exact-provider', 'fallback-enabled'] );

  const relaxedPool = snapshot.getProviderPool( 'gpt-4.1', 'chat/completions', {
    includeFallback: true,
    honorRandomRouting: false,
  } );
  expect( relaxedPool.providers.map( provider => provider.id ) ).toEqual( ['exact-provider', 'fallback-enabled', 'fallback-disabled'] );

  const noFallbackPool = snapshot.getProviderPool( 'gpt-4.1', 'chat/completions', {
    includeFallback: false,
  } );
  expect( noFallbackPool.providers.map( provider => provider.id ) ).toEqual( ['exact-provider'] );

  const autoPool = snapshot.getProviderPool( 'auto', 'chat/completions', {
    includeFallback: true,
    honorRandomRouting: true,
  } );
  expect( autoPool.providers.map( provider => provider.id ) ).toEqual( ['exact-provider', 'fallback-enabled', 'fallback-disabled'] );
} );

test( 'RoutingEngine builds ranked candidate plans with cooldown filtering metadata', () => {
  const snapshot = RoutingSnapshot.compile( [
    buildProviderConfig( 'provider-a', ['gpt-4.1'] ),
    buildProviderConfig( 'provider-b', ['gpt-4o-mini', 'gpt-4o'] ),
  ] as any );

  const engine = new RoutingEngine( snapshot, {
    getCooldownRemainingMs: ( providerId, modelName ) => {
      if ( providerId === 'provider-a' && modelName === 'gpt-4.1' ) {
        return 300;
      }
      if ( providerId === 'provider-b' && modelName === 'gpt-4o-mini' ) {
        return 120;
      }
      return 0;
    },
  } );

  const plan = engine.buildCandidatePlan( {
    requestedModel: 'unknown-model',
    endpoint: 'chat/completions',
    providerStartIndex: 1,
    randomizeProviderOrder: false,
    randomizeModelOrder: true,
    modelStartIndexByProvider: {
      'provider-a': 0,
      'provider-b': 1,
    },
  } );

  expect( plan.exactProviderCount ).toBe( 0 );
  expect( plan.fallbackProviderCount ).toBe( 2 );
  expect( plan.candidates.map( candidate => candidate.attemptKey ) ).toEqual( [
    'provider-b::gpt-4o',
    'provider-b::gpt-4o-mini',
    'provider-a::gpt-4.1',
  ] );
  expect( plan.readyCandidates.map( candidate => candidate.attemptKey ) ).toEqual( [
    'provider-b::gpt-4o',
  ] );
  expect( plan.readyCandidates.every( candidate => candidate.isReady ) ).toBe( true );
  expect( plan.candidates.filter( candidate => !candidate.isReady ).map( candidate => candidate.attemptKey ) ).toEqual( [
    'provider-b::gpt-4o-mini',
    'provider-a::gpt-4.1',
  ] );
} );

test( 'RoutingEngine integrates cooldown manager and rate-limit precheck gating', () => {
  const snapshot = RoutingSnapshot.compile( [
    buildProviderConfig( 'provider-a', ['gpt-4.1'] ),
    buildProviderConfig( 'provider-b', ['gpt-4o-mini'] ),
    buildProviderConfig( 'provider-c', ['gpt-4o'] ),
  ] as any );
  const cooldownManager = new BackendCooldownManager( 1_000 );
  cooldownManager.markCooldown( 'provider-a', 'gpt-4.1', 1_000 );

  const engine = new RoutingEngine( snapshot, {
    cooldownManager,
    precheckRateLimit: ( provider, modelName ) => {
      if ( provider.id === 'provider-b' && modelName === 'gpt-4o-mini' ) {
        return { allowed: false, retryAfterMs: 250 };
      }
      return true;
    },
  } );

  const plan = engine.buildCandidatePlan( {
    requestedModel: 'unknown-model',
    endpoint: 'chat/completions',
    randomizeProviderOrder: false,
    randomizeModelOrder: false,
  } );

  expect( plan.readyCandidates.map( candidate => candidate.attemptKey ) ).toEqual( ['provider-c::gpt-4o'] );
  expect( plan.candidates.find( candidate => candidate.attemptKey === 'provider-a::gpt-4.1' )?.isOnCooldown ).toBe( true );
  expect( plan.candidates.find( candidate => candidate.attemptKey === 'provider-b::gpt-4o-mini' )?.isRateLimited ).toBe( true );
  expect( plan.candidates.find( candidate => candidate.attemptKey === 'provider-b::gpt-4o-mini' )?.rateLimitRetryAfterMs ).toBe( 250 );
} );

test( 'RoutingEngine ranking uses provider stats with deterministic tie-breaking', () => {
  const snapshot = RoutingSnapshot.compile( [
    buildProviderConfig( 'provider-a', ['gpt-4.1'] ),
    buildProviderConfig( 'provider-b', ['gpt-4.1'] ),
  ] as any );
  const statsTracker = new ProviderStatsTracker( { alpha: 0.5 } );

  statsTracker.recordFailure( 'provider-a', 'gpt-4.1', 1_200 );
  statsTracker.recordFailure( 'provider-a', 'gpt-4.1', 900 );
  statsTracker.recordSuccess( 'provider-b', 'gpt-4.1', 150 );
  statsTracker.recordSuccess( 'provider-b', 'gpt-4.1', 180 );

  const engineWithStats = new RoutingEngine( snapshot, {
    getProviderStats: ( providerId, modelName ) => statsTracker.getStats( providerId, modelName ),
  } );

  const ranked = engineWithStats.buildCandidatePlan( {
    requestedModel: 'gpt-4.1',
    endpoint: 'chat/completions',
    randomizeProviderOrder: false,
    randomizeModelOrder: false,
  } );
  expect( ranked.readyCandidates.map( candidate => candidate.providerId ) ).toEqual( ['provider-b', 'provider-a'] );

  const tieEngine = new RoutingEngine( snapshot );
  const firstPlan = tieEngine.buildCandidatePlan( {
    requestedModel: 'gpt-4.1',
    endpoint: 'chat/completions',
    providerStartIndex: 1,
    randomizeProviderOrder: false,
    randomizeModelOrder: false,
  } );
  const secondPlan = tieEngine.buildCandidatePlan( {
    requestedModel: 'gpt-4.1',
    endpoint: 'chat/completions',
    providerStartIndex: 1,
    randomizeProviderOrder: false,
    randomizeModelOrder: false,
  } );

  expect( firstPlan.readyCandidates.map( candidate => candidate.providerId ) ).toEqual( ['provider-b', 'provider-a'] );
  expect( secondPlan.readyCandidates.map( candidate => candidate.providerId ) ).toEqual( ['provider-b', 'provider-a'] );
} );

test( 'RoutingSnapshotStore swaps immutable snapshots via rebuild', () => {
  let configs = [
    buildProviderConfig( 'provider-v1', ['gpt-4.1'] ),
  ] as any[];

  const store = new RoutingSnapshotStore( () => configs as any );
  const firstSnapshot = store.getSnapshot();
  expect( firstSnapshot.providers.map( provider => provider.id ) ).toEqual( ['provider-v1'] );

  configs = [
    buildProviderConfig( 'provider-v2', ['gpt-4o-mini'] ),
  ] as any[];

  const secondSnapshot = store.rebuild();
  expect( secondSnapshot.providers.map( provider => provider.id ) ).toEqual( ['provider-v2'] );
  expect( firstSnapshot.providers.map( provider => provider.id ) ).toEqual( ['provider-v1'] );
} );
