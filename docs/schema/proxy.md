# `proxy`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `proxy` | `string` (valid URL) | No | — |

## Description

URL of the proxy server to forward requests to. When set, all outbound API requests are routed through the specified proxy server before reaching the upstream provider.

## Constraints

- Must be a valid URL if provided.

## Example

```yaml
proxy: https://my-proxy.example.com
```
