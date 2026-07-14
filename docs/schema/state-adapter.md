# `state-adapter`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `state-adapter` | `"redis"`, `"memory"`, or `{ redis_url: string }` | No | — |

## Description

Storage backend for state management. Controls how the proxy stores request state, sessions, and in-flight data.

## Variants

### `"memory"` (default if omitted entirely)

In-memory storage. Fast, but state is lost on restart. Suitable for development or single-instance deployments.

### `"redis"`

Redis-backed storage. Requires a Redis instance; the proxy uses the `REDIS_URL` environment variable for the connection.

### `{ redis_url: string }`

Explicit Redis URL object. Equivalent to `"redis"` but lets you specify the connection URL directly in config.

## Constraints

- If an object, must contain `redis_url` (valid URL).
- Enum values are `"redis"` and `"memory"`.

## Examples

```yaml
# In-memory (no persistence across restarts)
state-adapter: memory

# Redis via environment variable
state-adapter: redis

# Explicit Redis URL
state-adapter:
  redis_url: redis://localhost:6379
```
