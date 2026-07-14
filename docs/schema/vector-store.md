# `vectorStore`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `vectorStore` | `VectorStoreSchema` | No | — |

## Description

Vector store proxy configuration. Forwards `/v1/vector_stores` and `/v1/files` requests to the target vector store API. See [dotlab-hq/vector-store](https://github.com/dotlab-hq/vector-store) for the compatible backend.

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | `string` (valid URL) | Yes | — | Base URL of the vector store API to proxy requests to |
| `apiKey` | `string` | Yes | — | API key sent as `Authorization` header to the vector store |

## Constraints

- `url` must be a valid URL.
- `apiKey` must be a non-empty string.
- Either both fields must be provided or the entire object is omitted.

## Example

```yaml
vectorStore:
  url: https://vector-store.example.com/v1
  apiKey: vs-xxx
```
