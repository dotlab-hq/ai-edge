# `spoofer`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `spoofer` | `boolean` | No | `false` |

## Description

If `true`, randomly generated IP spoofing headers (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, etc.) are added to every upstream request. Useful for testing geo-restricted routing behavior.

## Constraints

- Boolean value only.

## Example

```yaml
spoofer: true
```
