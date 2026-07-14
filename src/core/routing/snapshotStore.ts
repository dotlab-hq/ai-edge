import { CONFIG } from '@/utils/schema.lookup';

import { RoutingSnapshot } from '../RoutingSnapshot';
import type { RoutingSnapshotConfigResolver } from './snapshotTypes';
import type { OpenAIModelConfig } from './snapshotTypes';

export type { RoutingSnapshotConfigResolver } from './snapshotTypes';

export class RoutingSnapshotStore {
    private snapshot: RoutingSnapshot;

    constructor(
        private readonly configResolver: RoutingSnapshotConfigResolver,
        initialSnapshot?: RoutingSnapshot
    ) {
        this.snapshot = initialSnapshot ?? RoutingSnapshot.compile( configResolver() ?? [] );
    }

    getSnapshot(): RoutingSnapshot {
        return this.snapshot;
    }

    rebuild(): RoutingSnapshot {
        const nextSnapshot = RoutingSnapshot.compile( this.configResolver() ?? [] );
        this.snapshot = nextSnapshot;
        return nextSnapshot;
    }

    replace( snapshot: RoutingSnapshot ): RoutingSnapshot {
        this.snapshot = snapshot;
        return snapshot;
    }
}

export function buildRoutingSnapshotFromConfig(
    configs: ReadonlyArray<OpenAIModelConfig> | undefined = CONFIG.models.openai ?? []
): RoutingSnapshot {
    return RoutingSnapshot.compile( configs ?? [] );
}
