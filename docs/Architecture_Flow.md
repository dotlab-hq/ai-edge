# Architecture & Request Flow

This document explains how **ai-edge** (the LLM proxy) processes a request end to
end, and how the resilience features — **fallback**, **cooldown**, **rate
limiting**, **hedging**, and **health-based routing** — fit together.

## What the proxy is

ai-edge is a single Hono HTTP server that sits between clients and upstream LLM
providers. It exposes:

- **OpenAI-compatible** endpoints: `/v1/chat/completions`, `/v1/responses`,
  `/v1/completions`, `/v1/embeddings`, `/v1/images/*`, `/v1/audio/*`, `/v1/models`.
- **Anthropic-compatible** endpoint: `/anthropic/v1/messages`.
- **WebSocket** Responses API on `/v1/responses` (upgrade).
- **Skills & Files** storage APIs (MongoDB + S3) in both OpenAI and Anthropic namespaces.
- **Vector store** and **Realtime** API pass-through proxies.

Requests are authenticated, optionally enriched with skills/files/web-search/code
execution, routed to one or more upstream providers, and the response is
transformed back into the client's protocol.

## High-level flow

```
client
  │
  ▼
server.ts  ── global auth middleware (AI_EDGE_KEY)  ──  /health /stats /v1/models
  │
  ▼  app.route(...) dispatches by path prefix
  ├─ openAIProxy.getApp()       → /v1/* and /openai/*
  ├─ anthropicProxy.getApp()    → /anthropic/v1/messages
  ├─ skillsProxy.getApp()       → /anthropic/skills, /anthropic/files
  ├─ openAISkillsProxy.getApp() → /skills, /files, /v1/skills ...
  ├─ vectorStoreProxy / realtimeProxy
  └─ ResponsesWebSocket         → ws upgrade on /v1/responses
```

## OpenAI-compatible request path

For a typical `/v1/chat/completions` (see `src/core/openai/`):

1. **Auth** — `server.ts` global middleware compares `Authorization: Bearer`
   / `X-API-Key` against `AI_EDGE_KEY`. 401 if it does not match (auth is skipped
   when `AI_EDGE_KEY` is unset).
2. **Skill & file resolution** — if the skill resolver is initialized,
   `resolveOpenAIBody()` scans tool definitions for `skill:` references and
   messages for `file_id` references, fetches their content from MongoDB/S3, and
   inlines it into the request.
3. **Tool normalization** — `tool_search` tools and `defer_loading` fields are
   stripped so upstream providers don't choke on them.
4. **Code interpreter loop** — if `code_interpreter`/`python` tools are present
   and Daytona is configured, the request enters a multi-turn tool loop
   (`codeInterpreterFlow.ts`): it calls the upstream model, executes generated
   code in a sandbox, and feeds results back (up to ~4 iterations).
5. **Responses API conversion** — for `/v1/responses`, the body is converted to
   chat-completions format via `convertResponsesRequestToChat()`.
6. **Web search interception** — if `web_search` tools are present, the proxy
   queries Tavily/Exa, injects results as system context, and strips the tool.
7. **File search interception** — if `file_search` tools are present, the proxy
   queries the configured vector store, injects context, and strips the tool.
8. **Backend resolution + scoring** (below).
9. **Fallback loop** — iterate ready candidates; for each, run cooldown + rate-limit
   checks, send upstream, react to status.
10. **Response transformation** — convert chat response back to Responses format if
    needed, attach usage and tool metadata.
11. **Streaming** — for `stream: true`, upstream SSE is relayed (with a 15s
    keepalive heartbeat) and, for the Responses API, chat chunks are remapped to
    Responses SSE events. A terminal `response.completed` event is guaranteed.

## Anthropic-compatible request path

1. Same auth + skill resolution as above.
2. Web search interception via `WebSearchHandler` (Anthropic-specific).
3. **Anthropic → OpenAI conversion** (`AnthropicOpenAIBridge`):
   - system blocks extracted, tool defs converted to OpenAI function format,
   - content blocks normalized (text/image/audio/file/thinking/tool_use/tool_result),
   - `tool_search_tool_*` tools handled specially,
   - XML tool format supported for providers without native function calling.
4. Forward as `chat/completions`.
5. **OpenAI → Anthropic response conversion**: `finish_reason` → `stop_reason`,
   tool calls → `tool_use` blocks, Gemini native parts embedded for multi-turn replay.
6. Streaming: OpenAI SSE chunks → Anthropic SSE events
   (`message_start`, `content_block_*`, `message_delta`, `message_stop`).

## WebSocket Responses API path

`ResponsesWebSocket.ts` accepts a WS upgrade on `/v1/responses`:

- Receives `response.create` frames; maintains a per-connection `responseCache`
  so `previous_response_id` chains multi-turn conversations.
- Compresses input context when it exceeds ~80K tokens / 320K characters.
- Streams upstream responses as plain JSON frames (Codex client format, not SSE).
- Connection timeout: 60 min. Buffer-overflow protection drops non-critical chunks
  above 1 MB and closes above 4 MB.

## Routing, fallback & scoring

### Backend resolution — `RoutingSnapshot` + `RoutingEngine`

`RoutingSnapshot` is a precompiled index of every provider, grouped by endpoint
and normalized model id. `RoutingEngine.buildCandidatePlan()` produces a ranked
candidate list of `{ provider, model }` pairs:

- **Exact match**: providers whose model list contains the requested model
  (after `free:` modifier normalization) → `providerMatch: 'exact'`.
- **Fallback**: providers with `randomRouting !== false` (used for unlisted models
  or when exact providers are exhausted) → `providerMatch: 'fallback'`.
- **Capability filters**: STT/TTS/embeddings/image-only providers are excluded
  from chat routing.

### Scoring

Each candidate gets a `score` combining:

| Factor | Effect |
|---|---|
| Exact model match | **+100** |
| Success-rate EWMA | up to **+40** |
| Failure-rate EWMA | penalty up to **−55** |
| Consecutive-failure streak | penalty up to **−20** |
| Latency EWMA | penalty up to **−30** |
| On cooldown | **−1000** |
| Rate limited | **−750** |

Candidates are sorted by `isReady` first (cooldown & rate-limit clear), then by
score, then by match type, base rank, provider index, model name. The proxy
iterates `readyCandidates` in order during the fallback loop.

### Fallback loop

The proxy walks candidates in ranked order. For each:

1. Skip if on **cooldown** (see below).
2. Skip if **rate limited** (see below) — `retryAfterMs` recorded.
3. Send the upstream request via `fetchWithProxy()` (undici connection pooling,
   default 180s timeout, optional HTTPS proxy).
4. On **429 / 5xx / 401**, record a failure stat and try the next candidate.
5. On success, return the response and mark a success stat.
6. Follows 301/302/307/308 redirects by extracting the model from the `Location`
   header.

`HedgedDispatcher` can send to multiple candidates in parallel (default width 2,
max 8) and resolve on first success, aborting the rest — reducing tail latency.

### Rate limiting — `RateLimitManager`

Token-bucket + counter algorithm:

- **Per-minute** limits (tokens or requests): refill at `limit / 60` per second;
  estimated tokens ≈ characters / 4.
- **Per-day** limits (requests/tokens/audio-seconds): rolling 24h window.
- **STT**: audio seconds tracked per hour and per day.
- **TTS**: characters per day via `tokensPerDay`.
- In-process async locks (5s timeout) prevent concurrent-mutation races.
- `individualLimit: true` switches from per-provider to per-model accounting.
- Web search has its own per-provider limits (minute/day/month) inside
  `WebSearchManager`.

### Cooldown — `BackendCooldownManager`

After an upstream response, `markFromStatus()` puts a `providerId::model` pair on
cooldown if the status is retryable:

| Status | Cooldown |
|---|---|
| 429 / 5xx | **5 s** (default) |
| 401 | **60 s** (auth failure) |
| other | no cooldown |

Properties:

- **Key** = `providerId::modelName` (per-provider, per-model).
- **Overlap protection**: a longer already-active cooldown is never shortened.
- **Lazy cleanup**: expired entries are deleted on access (no background timer).
- **Non-retryable** = only 401, 429, 500–599 trigger cooldown.

The routing engine reads `getRemainingMs()` to deprioritize (score −1000) and skip
(`isReady = false`) cooled-down candidates, so traffic drains away from failing
backends automatically.

### Provider health — `ProviderStatsTracker`

Tracks EWMA (alpha = 0.2) of success rate, failure rate, latency, and consecutive
failures per provider+model. These feed the routing score above and are what make
the proxy prefer healthy backends without manual config.

## Startup sequence (`server.ts`)

1. Auth middleware installed.
2. `refreshUnifiedModelCatalog()` loads the unified model list.
3. Upstream connection pools are warmed (`warmUpstreamConnection`) for every
   unique `baseUrl`.
4. If `storage` is configured, skills/file proxies + skill resolver are
   initialized against MongoDB + S3.
5. Routes are mounted; the app is exported.

## Summary of resilience features

| Feature | Module | Purpose |
|---|---|---|
| Fallback routing | `RoutingEngine` | try alternate providers when one fails or is unknown |
| Health scoring | `ProviderStatsTracker` | steer traffic toward healthy backends |
| Cooldown | `BackendCooldownManager` | pause failing `provider::model` pairs briefly |
| Rate limiting | `RateLimitManager` | enforce per-minute/per-day provider limits |
| Hedging | `HedgedDispatcher` | cut tail latency by racing candidates |
| Connection reuse | `proxyFetch` | undici pooled upstream connections |
| Stream keepalive | `streamHeartbeat` | prevent idle timeouts on long streams |
