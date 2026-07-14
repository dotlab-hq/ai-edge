# `tools`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `tools` | `ToolsSchema` | No | — |

## Description

Optional built-in proxy tools. Currently supports **web search** (via Tavily or Exa) and a **code interpreter** (via Daytona). Used to satisfy OpenAI and Anthropic tool-calling requests.

## `webSearch`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tools` | array of `WebSearchToolSchema` | Yes | — | At least one web search provider |
| `defaults` | `WebSearchDefaultsSchema` | No | — | Default search behavior |

### Web Search Tool

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `"tavily"` or `"exa"` | Yes | — | Provider identifier |
| `apiKey` | `string` | Yes | — | API key for the provider |
| `rateLimit` | `WebSearchRateLimitSchema` | No | — | Per-provider rate limits |
| `timeoutMs` | `integer (> 0)` | No | — | Request timeout in milliseconds |
| `options` | `WebSearchProviderOptionsSchema` | No | — | Provider-specific options |

### Web Search Defaults

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `maxResults` | `integer (> 0)` | No | — |
| `expandQueries` | `boolean` | No | — |
| `maxExpandedQueries` | `integer (> 0)` | No | — |
| `parallelQueries` | `integer (> 0)` | No | — |
| `softTimeoutMs` | `integer (> 0)` | No | — |
| `providerTimeoutMs` | `integer (> 0)` | No | — |

### Web Search Rate Limit

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `requestsPerMinute` | `integer (> 0)` | No | — |
| `requestsPerDay` | `integer (> 0)` | No | — |
| `requestsPerMonth` | `integer (> 0)` | No | — |

### Web Search Provider Options

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `maxResults` | `integer (> 0)` | No | — |
| `searchDepth` | `"basic"` or `"advanced"` | No | — |
| `includeRawContent` | `boolean` | No | — |
| `includeAnswer` | `boolean` | No | — |

## `code_interpreter`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `"daytona"` | Yes | — | Provider identifier |
| `apiKey` | `string` | Yes | — | Daytona API key |
| `apiUrl` | `string` (URL) | No | — | Daytona API endpoint |
| `language` | `"python"`, `"typescript"`, `"javascript"` | No | — | Runtime language |
| `timeout` | `integer (> 0)` | No | — | Execution timeout in seconds |
| `target` | `"us"` or `"eu"` | No | — | Region target |
| `image` | `string` | No | — | Container image to use |
| `snapshot` | `string` | No | — | Snapshot ID |
| `resources` | `CodeInterpreterResourcesSchema` | No | — | CPU/memory/disk limits |
| `autoStopInterval` | `integer (>= 0)` | No | — | Auto-stop idle interval in seconds |
| `labels` | `record<string, string>` | No | — | Custom labels for the sandbox |
| `initialFiles` | `record<string, string>` | No | — | Files injected into the sandbox on creation |

### Code Interpreter Resources

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `cpu` | `integer (> 0)` | No | — |
| `memory` | `integer (> 0)` | No | — |
| `disk` | `integer (> 0)` | No | — |

## Example

```yaml
tools:
  webSearch:
    tools:
      - type: tavily
        apiKey: tvly-xxx
        timeoutMs: 5000
    defaults:
      maxResults: 5
      expandQueries: true
  code_interpreter:
    type: daytona
    apiKey: dtn-xxx
    language: python
    timeout: 60
```
