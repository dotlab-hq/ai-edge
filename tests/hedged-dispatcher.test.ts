import { expect, test } from 'bun:test';
import { HedgedDispatcher, HedgedDispatchExhaustedError } from '../src/core/HedgedDispatcher';

function wait( ms: number ): Promise<void> {
    return new Promise( resolve => setTimeout( resolve, ms ) );
}

test( 'HedgedDispatcher returns first successful attempt', async () => {
    const dispatcher = new HedgedDispatcher();
    const started: number[] = [];

    const result = await dispatcher.dispatch(
        [1, 2, 3],
        async ( candidate ) => {
            started.push( candidate );
            if ( candidate === 1 ) {
                await wait( 100 );
                throw new Error( 'slow failure' );
            }
            if ( candidate === 2 ) {
                await wait( 20 );
                return 'winner';
            }
            return 'should-not-start';
        },
        { maxWidth: 2 }
    );

    expect( result.value ).toBe( 'winner' );
    expect( result.candidate ).toBe( 2 );
    expect( started ).toEqual( [1, 2] );
} );

test( 'HedgedDispatcher cancels in-flight losers after winner resolves', async () => {
    const dispatcher = new HedgedDispatcher();
    let loserAborted = false;

    const result = await dispatcher.dispatch(
        ['slow', 'fast'],
        async ( candidate, context ) => {
            if ( candidate === 'slow' ) {
                return await new Promise<string>( ( resolve, reject ) => {
                    const timer = setTimeout( () => resolve( 'slow' ), 500 );
                    context.signal.addEventListener( 'abort', () => {
                        loserAborted = true;
                        clearTimeout( timer );
                        reject( new Error( 'aborted' ) );
                    }, { once: true } );
                } );
            }

            await wait( 15 );
            return 'fast';
        },
        { maxWidth: 2 }
    );

    await wait( 30 );

    expect( result.value ).toBe( 'fast' );
    expect( loserAborted ).toBe( true );
} );

test( 'HedgedDispatcher surfaces all-fail behavior', async () => {
    const dispatcher = new HedgedDispatcher();
    let caught: unknown;

    try {
        await dispatcher.dispatch(
            ['a', 'b', 'c'],
            async ( candidate ) => {
                await wait( 5 );
                throw new Error( `fail-${candidate}` );
            },
            { maxWidth: 2 }
        );
    } catch ( error ) {
        caught = error;
    }

    expect( caught ).toBeInstanceOf( HedgedDispatchExhaustedError );
    const exhausted = caught as HedgedDispatchExhaustedError<string>;
    expect( exhausted.attemptedCount ).toBe( 3 );
    expect( exhausted.failures.map( failure => failure.candidate ) ).toEqual( ['a', 'b', 'c'] );
} );

test( 'HedgedDispatcher enforces width and attempt caps', async () => {
    const dispatcher = new HedgedDispatcher( {
        defaultMaxWidth: 2,
        maxWidthCap: 2,
        maxAttemptsCap: 3,
    } );

    let active = 0;
    let peakActive = 0;
    const started: number[] = [];
    let caught: unknown;

    try {
        await dispatcher.dispatch(
            [1, 2, 3, 4, 5],
            async ( candidate ) => {
                started.push( candidate );
                active += 1;
                peakActive = Math.max( peakActive, active );
                await wait( 20 );
                active -= 1;
                throw new Error( `fail-${candidate}` );
            },
            {
                maxWidth: 9,
                maxAttempts: 9,
            }
        );
    } catch ( error ) {
        caught = error;
    }

    expect( peakActive ).toBe( 2 );
    expect( started ).toEqual( [1, 2, 3] );
    expect( caught ).toBeInstanceOf( HedgedDispatchExhaustedError );
    const exhausted = caught as HedgedDispatchExhaustedError<number>;
    expect( exhausted.attemptedCount ).toBe( 3 );
} );
