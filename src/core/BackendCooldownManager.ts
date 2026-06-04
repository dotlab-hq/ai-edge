const DEFAULT_COOLDOWN_MS = 5_000;

export function isRetryableUpstreamStatus( status: number ): boolean {
    return status === 429 || ( status >= 500 && status <= 599 );
}

export class BackendCooldownManager {
    private readonly blockedUntilByKey = new Map<string, number>();

    constructor( private readonly defaultCooldownMs: number = DEFAULT_COOLDOWN_MS ) { }

    markFromStatus( providerId: string, modelName: string, status: number, cooldownMs: number = this.defaultCooldownMs ): boolean {
        if ( !isRetryableUpstreamStatus( status ) ) {
            return false;
        }
        this.markCooldown( providerId, modelName, cooldownMs );
        return true;
    }

    markCooldown( providerId: string, modelName: string, cooldownMs: number = this.defaultCooldownMs ): number {
        const key = this.buildKey( providerId, modelName );
        const existing = this.blockedUntilByKey.get( key );
        const blockedUntil = Date.now() + cooldownMs;

        if ( typeof existing === 'number' && existing > blockedUntil ) {
            return existing;
        }

        this.blockedUntilByKey.set( key, blockedUntil );
        return blockedUntil;
    }

    isOnCooldown( providerId: string, modelName: string ): boolean {
        return this.getRemainingMs( providerId, modelName ) > 0;
    }

    getRemainingMs( providerId: string, modelName: string ): number {
        const key = this.buildKey( providerId, modelName );
        const blockedUntil = this.blockedUntilByKey.get( key );

        if ( typeof blockedUntil !== 'number' ) {
            return 0;
        }

        const remainingMs = blockedUntil - Date.now();
        if ( remainingMs <= 0 ) {
            this.blockedUntilByKey.delete( key );
            return 0;
        }

        return remainingMs;
    }

    private buildKey( providerId: string, modelName: string ): string {
        return `${providerId}::${modelName}`;
    }
}

export const backendCooldownManager = new BackendCooldownManager();
