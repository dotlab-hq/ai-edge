# `realtime`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `realtime` | `RealtimeSchema` | No | — |

## Description

Realtime API proxy configuration. Forwards `/v1/realtime` requests to the target OpenAI Realtime API endpoint (e.g. `https://api.openai.com/v1`).

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | `string` (valid URL) | Yes | — | Base URL of the Realtime API to proxy requests to |
| `apiKey` | `string` | Yes | — | API key sent as `Authorization` header to the Realtime API |

## Constraints

- `url` must be a valid URL.
- `apiKey` must be a non-empty string.
- Either both fields must be provided or the entire object is omitted.

## Example

```yaml
realtime:
  url: https://api.openai.com/v1
  apiKey: sk-xxx
```
