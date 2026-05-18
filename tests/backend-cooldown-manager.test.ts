import { expect, test } from 'bun:test';
import { BackendCooldownManager, isRetryableUpstreamStatus } from '../src/core/BackendCooldownManager';

test( 'isRetryableUpstreamStatus only matches 429 and 5xx statuses', () => {
  expect( isRetryableUpstreamStatus( 200 ) ).toBe( false );
  expect( isRetryableUpstreamStatus( 400 ) ).toBe( false );
  expect( isRetryableUpstreamStatus( 429 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 500 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 503 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 599 ) ).toBe( true );
  expect( isRetryableUpstreamStatus( 600 ) ).toBe( false );
} );

test( 'BackendCooldownManager marks cooldown for retryable statuses and expires it', async () => {
  const manager = new BackendCooldownManager( 40 );

  expect( manager.markFromStatus( 'p1', 'm1', 400 ) ).toBe( false );
  expect( manager.isOnCooldown( 'p1', 'm1' ) ).toBe( false );

  expect( manager.markFromStatus( 'p1', 'm1', 429 ) ).toBe( true );
  expect( manager.isOnCooldown( 'p1', 'm1' ) ).toBe( true );
  expect( manager.getRemainingMs( 'p1', 'm1' ) ).toBeGreaterThan( 0 );

  await new Promise( resolve => setTimeout( resolve, 60 ) );
  expect( manager.isOnCooldown( 'p1', 'm1' ) ).toBe( false );
  expect( manager.getRemainingMs( 'p1', 'm1' ) ).toBe( 0 );
} );

test( 'BackendCooldownManager tracks cooldown per provider-model pair', () => {
  const manager = new BackendCooldownManager( 1_000 );

  manager.markFromStatus( 'provider-a', 'model-a', 500 );
  expect( manager.isOnCooldown( 'provider-a', 'model-a' ) ).toBe( true );
  expect( manager.isOnCooldown( 'provider-a', 'model-b' ) ).toBe( false );
  expect( manager.isOnCooldown( 'provider-b', 'model-a' ) ).toBe( false );
} );
