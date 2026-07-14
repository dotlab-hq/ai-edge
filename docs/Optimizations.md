# Optimizations (implemented and suggested)

## Implemented

### Deduplicated identical routing helpers
`openai/routing.ts` and `anthropic/routing.ts` both defined byte-identical `isGeminiProvider`, `configHasModel`, `isEmbeddingsEnabled`, and `isAutoModel` functions. Consolidated into `src/core/routing/shared.ts` — both routing modules now import from the shared source.

**Why safe:** The functions were pure, with identical implementations (just different type annotations). The re-exports preserve all existing import paths.

### Removed dead code
- `AnthropicProxy.scoreProvider` (private, never called) — removed
- Several unused imports across split files — removed

---

## Suggestions (not implemented — low priority, safe to add later)

### 1. Merge `scoreProvider` and `getCandidateModelsForProvider`
`openai/routing.ts` and `anthropic/routing.ts` both implement scoring + candidate derivation with slightly different weights and arguments (`BackendState` vs `Modality[]`). Unifying behind a common interface would reduce maintenance surface.

**Risk:** Medium — the weight constants differ (openai includes `scoreModelSpeedHint`, anthropic doesn't). Would need careful A/B testing.

### 2. `configHasModel` call in `getBackendsForModel` — normalize once
`getBackendsForModel` iterates all provider configs and calls `configHasModel(config, modelName)` per config. Each call normalizes `modelName` via `stripFreeModifier` — could normalize once outside the loop. The fix is a one-line variable hoist.

**Impact:** Negligible in practice (few providers, cache hit), but cleaner.

### 3. Connection pool warmup parallelism
`warmConfiguredUpstreamConnections()` already uses `Promise.allSettled` — optimal.

### 4. `mergeUnifiedCatalog` uses `orderedIds.includes(normalizedId)` — O(N) per model
For large provider lists, switching to a `Set` for dedup tracking would avoid O(N²) in model enumeration. Only matters if dozens of providers are configured simultaneously.

### 5. Route cache eviction in `getBackendsForModel` is FIFO (delete first key)
A true LRU cache (access-time aware) would improve hit rates under skewed traffic, but the current FIFO cache is simple and bounded. Only worth changing if cache misses become measurable.
