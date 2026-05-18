const DEFAULT_MAX_WIDTH = 2;
const DEFAULT_MAX_WIDTH_CAP = 8;
const DEFAULT_MAX_ATTEMPTS_CAP = 128;

export type HedgedDispatchContext = Readonly<{
    candidateIndex: number;
    rank: number;
    signal: AbortSignal;
}>;

export type HedgedDispatchExecutor<TCandidate, TResult> = (
    candidate: TCandidate,
    context: HedgedDispatchContext
) => Promise<TResult>;

export type HedgedDispatchOptions = Readonly<{
    maxWidth?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
}>;

export type HedgedDispatcherConfig = Readonly<{
    defaultMaxWidth?: number;
    maxWidthCap?: number;
    maxAttemptsCap?: number;
}>;

export type HedgedDispatchSuccess<TCandidate, TResult> = Readonly<{
    candidate: TCandidate;
    candidateIndex: number;
    rank: number;
    value: TResult;
    attemptedCount: number;
}>;

export type HedgedDispatchFailure<TCandidate> = Readonly<{
    candidate: TCandidate;
    candidateIndex: number;
    rank: number;
    error: unknown;
}>;

export class HedgedDispatchExhaustedError<TCandidate = unknown> extends Error {
    readonly failures: readonly HedgedDispatchFailure<TCandidate>[];
    readonly attemptedCount: number;

    constructor( failures: readonly HedgedDispatchFailure<TCandidate>[] ) {
        super( 'All hedged attempts failed' );
        this.name = 'HedgedDispatchExhaustedError';
        this.failures = failures;
        this.attemptedCount = failures.length;
    }
}

export class HedgedDispatcher {
    private readonly defaultMaxWidth: number;
    private readonly maxWidthCap: number;
    private readonly maxAttemptsCap: number;

    constructor( config: HedgedDispatcherConfig = {} ) {
        this.defaultMaxWidth = normalizePositiveInt( config.defaultMaxWidth, DEFAULT_MAX_WIDTH );
        this.maxWidthCap = normalizePositiveInt( config.maxWidthCap, DEFAULT_MAX_WIDTH_CAP );
        this.maxAttemptsCap = normalizePositiveInt( config.maxAttemptsCap, DEFAULT_MAX_ATTEMPTS_CAP );
    }

    async dispatch<TCandidate, TResult>(
        rankedCandidates: readonly TCandidate[],
        executor: HedgedDispatchExecutor<TCandidate, TResult>,
        options: HedgedDispatchOptions = {}
    ): Promise<HedgedDispatchSuccess<TCandidate, TResult>> {
        if ( rankedCandidates.length === 0 ) {
            throw new HedgedDispatchExhaustedError<TCandidate>( [] );
        }

        const requestedWidth = normalizePositiveInt( options.maxWidth, this.defaultMaxWidth );
        const effectiveWidth = Math.min( requestedWidth, this.maxWidthCap );
        const requestedMaxAttempts = normalizePositiveInt( options.maxAttempts, rankedCandidates.length );
        const attemptLimit = Math.min( rankedCandidates.length, requestedMaxAttempts, this.maxAttemptsCap );

        if ( attemptLimit <= 0 ) {
            throw new HedgedDispatchExhaustedError<TCandidate>( [] );
        }

        const controllers = new Map<number, AbortController>();
        const failures: HedgedDispatchFailure<TCandidate>[] = [];
        let nextCandidateIndex = 0;
        let activeCount = 0;
        let attemptedCount = 0;
        let settled = false;
        let rejectedByAbortSignal = false;

        const outerSignal = options.signal;

        return new Promise<HedgedDispatchSuccess<TCandidate, TResult>>( ( resolve, reject ) => {
            const abortAllInFlight = ( winnerIndex?: number ) => {
                for ( const [index, controller] of controllers.entries() ) {
                    if ( winnerIndex !== undefined && winnerIndex === index ) {
                        continue;
                    }
                    controller.abort();
                }
            };

            const rejectFromAbortSignal = () => {
                if ( settled ) {
                    return;
                }
                settled = true;
                rejectedByAbortSignal = true;
                abortAllInFlight();
                reject( createAbortError() );
            };

            const outerAbortListener = () => rejectFromAbortSignal();
            if ( outerSignal?.aborted ) {
                rejectFromAbortSignal();
                return;
            }
            if ( outerSignal ) {
                outerSignal.addEventListener( 'abort', outerAbortListener, { once: true } );
            }

            const cleanupOuterSignal = () => {
                if ( outerSignal ) {
                    outerSignal.removeEventListener( 'abort', outerAbortListener );
                }
            };

            const finalizeIfExhausted = () => {
                if ( settled ) {
                    return;
                }
                if ( attemptedCount < attemptLimit || activeCount > 0 ) {
                    return;
                }
                settled = true;
                cleanupOuterSignal();
                reject( new HedgedDispatchExhaustedError( failures ) );
            };

            const launchNext = () => {
                while ( !settled && activeCount < effectiveWidth && attemptedCount < attemptLimit ) {
                    const candidateIndex = nextCandidateIndex;
                    const candidate = rankedCandidates[candidateIndex]!;
                    nextCandidateIndex += 1;
                    attemptedCount += 1;
                    activeCount += 1;

                    const controller = new AbortController();
                    controllers.set( candidateIndex, controller );
                    const rank = candidateIndex + 1;

                    Promise.resolve()
                        .then( () => executor( candidate, {
                            candidateIndex,
                            rank,
                            signal: controller.signal,
                        } ) )
                        .then( value => {
                            if ( settled ) {
                                return;
                            }
                            settled = true;
                            cleanupOuterSignal();
                            abortAllInFlight( candidateIndex );
                            resolve( {
                                candidate,
                                candidateIndex,
                                rank,
                                value,
                                attemptedCount,
                            } );
                        } )
                        .catch( error => {
                            if ( settled ) {
                                return;
                            }
                            if ( rejectedByAbortSignal ) {
                                return;
                            }
                            failures.push( {
                                candidate,
                                candidateIndex,
                                rank,
                                error,
                            } );
                        } )
                        .finally( () => {
                            controllers.delete( candidateIndex );
                            activeCount -= 1;
                            launchNext();
                            finalizeIfExhausted();
                        } );
                }
            };

            launchNext();
            finalizeIfExhausted();
        } );
    }
}

function normalizePositiveInt( value: number | undefined, fallback: number ): number {
    if ( typeof value !== 'number' || !Number.isFinite( value ) ) {
        return fallback;
    }
    if ( value <= 0 ) {
        return 1;
    }
    return Math.floor( value );
}

function createAbortError(): Error {
    const error = new Error( 'Hedged dispatch aborted' );
    error.name = 'AbortError';
    return error;
}
