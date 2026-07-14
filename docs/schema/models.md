# `models`

`models` has two keys — `openai` and `anthropic` — each an array of provider configs. Both arrays are required (minimum 1 entry each). If omitted, no models from that provider will be available.

## Common Provider Fields

Both `OpenAIModelSchema` and `AnthropicModelSchema` share most fields:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | Yes | — | Unique provider identifier |
| `name` | `string` | Yes | — | Human-readable provider name |
| `models` | `string[]` or `ModelWithRateLimitSchema[]` | Yes | — | Model identifiers or per-model config objects |
| `baseUrl` | `string` (URL) | Yes | — | Base URL of the provider API |
| `apiKey` | `string` | Yes | — | API key for the provider |
| `rateLimit` | `RateLimitSpec` | No | — | Backend-level rate limit (forbidden when using per-model rate limits) |
| `individualLimit` | `boolean` | No | `false` | If `true`, per-model rate limits are enforced |
| `randomRouting` | `boolean` | No | `true` | If `false`, disables this provider as a fallback for unknown models or exhausted exact-model providers |
| `modalities` | `ModalitiesSchema` | No | — | Supported input/output modalities |
| `reasoning_efforts` | `ReasoningEffort[]` | No | — | Explicitly supported reasoning effort levels |
| `default_reasoning` | `ReasoningEffort` | No | — | Default reasoning effort when reasoning is explicitly configured |

## Reasoning Effort Levels

`"none"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`

## Modalities

- **Input:** `"text"`, `"image"`, `"audio"`, `"file"`, `"pdf"`
- **Output:** `"text"`, `"audio"`

## Per-Model Config (`ModelWithRateLimitSchema`)

Used when `models` entries are objects instead of plain strings:

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `model` | `string` | Yes | — |
| `rateLimit` | `RateLimitSpec` | Yes | — |
| `modalities` | `ModalitiesSchema` | No | — |
| `reasoning_efforts` | `ReasoningEffort[]` | No | — |
| `default_reasoning` | `ReasoningEffort` | No | — |

## OpenAI-Specific Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `imageModels` | `ImageModelsSchema` | No | — | Image routing flags (`image_generation`, `image_editing`) |
| `embeddings` | `boolean` | No | `false` | If `true`, provider is reserved for embeddings routing |
| `stt` | `boolean` | No | `false` | If `true`, provider is reserved for speech-to-text routing |
| `tts` | `boolean` | No | `false` | If `true`, provider is reserved for text-to-speech routing |

### Image Models

| Field | Type | Default |
|-------|------|---------|
| `image_generation` | `boolean` | — |
| `image_editing` | `boolean` | — |

At least one must be `true` if `imageModels` is provided.

## Validation Rules (both providers)

1. **Models array must be uniform:** Either all strings or all objects with `{ model, rateLimit }`. Mixing is rejected.
2. **Backend rate limit forbidden with per-model limits:** If `models` contains objects, `rateLimit` (provider-level) must not be set, and `individualLimit` must be `true`.
3. **Reasoning config is exclusive:** `reasoning_efforts` / `default_reasoning` can be defined at provider level OR per-model, but not both.
4. **`default_reasoning` must be in `reasoning_efforts`:** If both are provided, `default_reasoning` must be one of the values in `reasoning_efforts`.
5. **STT/embeddings mutual exclusion:** `stt` and `embeddings` cannot both be `true`.
6. **STT + image models conflict:** `stt` cannot be `true` when `imageModels` is provided.
7. **TTS mutual exclusions:** `tts` cannot coexist with `embeddings`, `imageModels`, or `stt`.
8. **Image models require at least one endpoint:** If `imageModels` is provided, `image_generation` or `image_editing` must be `true`.

## Example

```yaml
models:
  openai:
    - id: openai-main
      name: OpenAI
      models:
        - gpt-4o
        - gpt-4-turbo
      baseUrl: https://api.openai.com/v1
      apiKey: sk-xxx
      rateLimit:
        requestsPerMinute: 500
      modalities:
        input: [text, image, audio]
        output: [text]
      reasoning_efforts: [low, medium, high]
      default_reasoning: medium
  anthropic:
    - id: anthropic-main
      name: Anthropic
      models:
        - claude-sonnet-4-20250514
      baseUrl: https://api.anthropic.com
      apiKey: sk-ant-xxx
```
