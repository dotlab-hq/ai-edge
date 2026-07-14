import type { SearchOptions } from './types';
import { clampInteger } from './utils';
import type { ResolvedDefaultOptions } from './defaults';

export function getProviderTimeout(
    tool: { timeoutMs?: number },
    options: SearchOptions,
    defaults: ResolvedDefaultOptions
): number {
    return clampInteger(tool.timeoutMs, 500, 30000, options.providerTimeoutMs ?? defaults.providerTimeoutMs);
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
): Promise<T> {
    if (timeoutMs <= 0) {
        throw new Error(message);
    }

    return await new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timeoutId);
                resolve(value);
            },
            (error) => {
                clearTimeout(timeoutId);
                reject(error);
            }
        );
    });
}
