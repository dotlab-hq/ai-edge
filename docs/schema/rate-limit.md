# `rateLimit`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `rateLimit` | `RateLimitSpec \| undefined` | No | — |

## Description

Global rate limit applied to all models unless `individualLimit` is `true` on a provider. Each dimension is independent — omitting a field means that dimension is unlimited for the global limiter.

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tokensPerMinute` | `integer (> 0)` | No | — | Max tokens per minute across all providers |
| `requestsPerMinute` | `integer (> 0)` | No | — | Max requests per minute across all providers |
| `requestsPerDay` | `integer (> 0)` | No | — | Max requests per day across all providers |
| `audioSecondsPerHour` | `integer (> 0)` | No | — | Max seconds of audio processed per hour (STT) |
| `audioSecondsPerDay` | `integer (> 0)` | No | — | Max seconds of audio processed per day (STT) |
| `tokensPerDay` | `integer (> 0)` | No | — | Max tokens consumed per day |

## Constraints

- All numeric fields must be positive integers.
- If omitted entirely, no global rate limiting is enforced.

## Example

```yaml
rateLimit:
  tokensPerMinute: 100000
  requestsPerMinute: 500
  tokensPerDay: 2000000
  audioSecondsPerHour: 3600
```
