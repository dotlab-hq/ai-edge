# AGENTS.md — Development Guidelines for ai-edge

Welcome to **ai-edge** (`llm-proxy`), a high-performance local LLM routing server with OpenAI and Anthropic compatibility, multi-provider load balancing, rate limiting, and code execution capabilities.

## 🚀 Quick Reference

### Build & Run
- **Start development server:** `bun run dev`
- **Build CLI and server bundles:** `bun run build`
- **Start production server:** `bun run start`
- **Type check:** `bun run typecheck`
- **Generate schema:** `bun run generate:schema`

### Testing
- **Run tests:** `bun test`
- **Run specific production tests:** `bun run testify`

---

## 🏗️ Architecture & Component Boundaries

- **`src/server.ts` & `src/dev.ts`**: Entry points for the proxy server.
- **`src/cli/`**: CLI entry point and commands (`ai-edge`).
- **`src/core/`**: Core proxy routing, multi-provider fallbacks,hedged requests, rate limiting, and bridge adapters:
  - `RoutingEngine.ts` / `ProviderStatsTracker.ts`: Model selection, load balancing, and failover tracking.
  - `OpenAIProxy.ts` / `AnthropicProxy.ts`: Protocol adapters and API request bridging.
  - `CodeInterpreterManager.ts` / `CodeInterpreterHandler.ts`: Code execution handling (e.g. Daytona integration).
  - `WebSearchManager.ts`: Tavily/Exa web search tool integrations.
- **`src/schema/`**: Zod schemas and model configurations.
- **`model.jsonc`**: Configuration file defining backend instances, API keys, rate limits, and proxy options.

---

## 📌 Development Conventions

1. **Package Manager**: Use **`bun`** for dependency management, testing, building, and running scripts.
2. **TypeScript & Types**: Maintain strict typing; run `bun run typecheck` before finalizing major changes.
3. **Configuration First**: When adding new provider features, update both Zod definitions in `src/schema/` and run `bun run generate:schema` to keep `schema.json` synchronized.
