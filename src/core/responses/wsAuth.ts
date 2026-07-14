import type { IncomingMessage } from 'http';

export function validateUpgradeAuth( req: IncomingMessage ): boolean {
    const requiredKey = process.env.AI_EDGE_KEY?.trim();
    if ( !requiredKey ) return true;

    const authHeader = req.headers['authorization'] as string | undefined;
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

    if ( apiKeyHeader ) {
        return apiKeyHeader.trim() === requiredKey;
    }
    if ( authHeader ) {
        const trimmed = authHeader.trim();
        const token = trimmed.toLowerCase().startsWith( 'bearer ' )
            ? trimmed.slice( 7 ).trim()
            : trimmed;
        return token === requiredKey;
    }
    return false;
}
