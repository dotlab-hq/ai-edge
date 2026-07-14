# `$schema`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `$schema` | `string` (valid URL) | Yes | — |

## Description

URL to the JSON Schema that this configuration adheres to. This field is **required** — it is used by schema-aware editors and validators to provide autocomplete and type checking for the config file.

## Constraints

- Must be a valid URL.
- Must be provided (no default).

## Example

```yaml
$schema: https://llm-proxy.example.com/schema.json
```
