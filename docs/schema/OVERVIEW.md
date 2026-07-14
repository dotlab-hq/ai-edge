# LLM-Proxy Schema Overview

The proxy is configured by a single YAML/JSON object matching the root `Config` schema. Every property is optional unless noted; omitted keys fall back to their declared defaults.

## Root Shape

```yaml
proxy: string (URL, optional)            # upstream proxy to forward requests through
spoofer: boolean (default: false)        # add IP-spoofing headers to every upstream request
$schema: string (URL, required)          # JSON Schema reference URL
state-adapter: string | object           # state backend: "redis", "memory", or { redis_url }
rateLimit: object (optional)             # global per-dimension rate limits
storage: object (optional)               # MongoDB + S3 backends for skills/files
tools: object (optional)                 # built-in tools: webSearch, code_interpreter
vectorStore: object (optional)           # proxy for /v1/vector_stores requests
realtime: object (optional)              # proxy for /v1/realtime requests
models:                                   # provider definitions
  openai: ProviderConfig[] (required, min 1)
  anthropic: ProviderConfig[] (required, min 1)
```

## File Index

| File | Property | Description |
|------|----------|-------------|
| [proxy.md](./proxy.md) | `proxy` | Upstream proxy URL |
| [spoofer.md](./spoofer.md) | `spoofer` | IP spoofing headers toggle |
| [schema-url.md](./schema-url.md) | `$schema` | JSON Schema reference URL |
| [state-adapter.md](./state-adapter.md) | `state-adapter` | State backend selection |
| [rate-limit.md](./rate-limit.md) | `rateLimit` | Global rate limits (tokens, requests, audio) |
| [storage.md](./storage.md) | `storage` | MongoDB URI + S3 config |
| [tools.md](./tools.md) | `tools` | WebSearch + CodeInterpreter configs |
| [vector-store.md](./vector-store.md) | `vectorStore` | Vector store proxy |
| [realtime.md](./realtime.md) | `realtime` | Realtime API proxy |
| [models.md](./models.md) | `models.openai[]` / `models.anthropic[]` | Provider configs |
