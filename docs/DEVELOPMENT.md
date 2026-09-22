# Development Guide — Qwen Proxy Gateway

## Runtime & tooling

- **Bun ≥ 1.1** is the primary runtime (`bun run src/cli.ts …`, `bun test`).
- **Node ≥ 20** fallback via `tsx` (`npm run start:node`, `npm run dev:node`).
- TypeScript strict; ESM (`"type": "module"`); relative imports use `.js` extensions.
- Lint/format: [Biome](https://biomejs.dev) (`bun run lint`, `bun run lint:fix`).
- Types: `bun run typecheck` (`tsc --noEmit`).

## Scripts

| Command | What it does |
|---|---|
| `bun start` / `bun run src/cli.ts start` | run the gateway (Bun) |
| `npm run start:node` | run under Node + tsx |
| `bun run dev` | watch mode (Bun) |
| `bun run test` | unit + integration tests, one process per file (`scripts/test.sh`) |
| `bun run test:file tests/x.test.ts` | single test file |
| `bun run smoke` | e2e against a **running** instance (`BASE_URL`, `MASTER_KEY`) |
| `bun run typecheck` / `bun run lint` | static checks |

Tests must stay **process-isolated**: singletons (configService, accountManager,
rate-limit buckets) are module-level, so `scripts/test.sh` spawns `bun test <file>`
per file. When adding a test that mutates global state, give it its own file and a
private `QWEN_PROXY_HOME` temp dir (see `tests/accountManager.test.ts`).

`bun test` (all files in one process) must pass too — singletons such as
`configService` are shared there, so call `configService.load(true)` after
setting env vars and reset per-test state (`resetRateLimit()`) in `beforeEach`.

## Repository map

```
src/
  index.tsx          Hono app export + direct-run bootstrap
  app.ts             route assembly (middleware → routes → dashboard)
  server.ts          Bun.serve / @hono/node-server adapter
  cluster.ts         node:cluster wrapper (WORKERS)
  cli.ts             qg CLI
  bootstrap.ts       banner, maintenance timers, graceful shutdown
  models.json        model catalog (ids, aliases, fallbacks)
  routes/            chat.ts (dialect-agnostic orchestrator), chatStreaming.ts
                     (SSE pump + pluggable ChunkEmitter), chatNonStreaming.ts,
                     messages.ts (Anthropic Messages API), accounts.ts (password /
                     cookies / verify), models.ts,
                     config.ts, setup.ts, health.ts, schemas.ts, chunkBuilders.ts,
                     dashboard/ (index.ts composes layout.ts + one module per page:
                     overview.ts, accounts.ts, logs.ts, network.ts, settings.ts —
                     each exports `page` HTML and `register(api)`)
  services/          accountManager, sessionPool, auth, loginService, tokenRefresh,
                     tokenCache, qwen (provider iface), realProvider, mockProvider,
                     promptRenderer, qwenModels, modelRouter, modelHealth,
                     contentFilter, logStore, monitorStore, networkDebug,
                     configService, systemLogger, playwright,
                     captureProxy (ticket store + chat.qwen.ai login portal)
  tools/             xmlToolParser (streaming tool-call extraction),
                     schemaValidator (JSON Schema subset), guard (spam/loop guards)
  middleware/        auth (bearer + master key), rateLimit (token bucket), cors
  utils/             logger, retry, streaming (SSE), thinkTagStripper, xmlStripper,
                     tokenEstimator, bxUaGenerator, crypto, ids, paths,
                     anthropic (Anthropic ⇄ OpenAI conversion + SSE emitter),
                     cookies (Cookie-Editor/header/netscape parsing + audit)
scripts/             smoke.ts (e2e), test.sh (isolated runner)
tests/               bun:test suites
install.ps1/sh       OS installers · install/ client configurators
docs/                API, DEPLOYMENT, DEVELOPMENT, TROUBLESHOOTING
```

## Key design rules

1. **Providers are pluggable.** Implement `QwenProvider` (login/refresh/listModels/
   streamChat) and register it in `services/qwen.ts`. `mockProvider` is the
   reference for event semantics (`delta`, `reasoning`, `usage`, `finish`, `error`).
2. **Everything streaming is incremental.** Filters (`ThinkTagStripper`,
   `XmlStripper`) and `StreamingToolParser` are push/flush state machines that
   tolerate tags split across chunk boundaries. Never buffer whole responses in
   the streaming path.
3. **Failover contract.** `QwenError.rateLimited` → account cooldown;
   `authFailed` → one forced re-login; `retryable` → next account. The chat
   orchestrator peeks the first upstream event so retries happen *before* any
   byte reaches the client.
4. **Config is live.** Read via `configService.get()` at request time; never cache
   values in module scope. `PUT /dashboard/api/config` persists + hot-reloads.
5. **No secrets in logs.** `networkDebug` masks auth headers; account lists never
   expose passwords; master key is compared with `safeEqual`.

## Tag-literal hygiene (important!)

Source files must not contain raw *closing* tool-call tag literals (antml-prefixed
envelopes, legacy attribute dialects, etc.): they break LLM tooling and scanners.
Build them via concatenation, e.g. `['<', '/', 'tool_response', '>'].join('')`,
and regexes via `new RegExp('<\\/' + 'function\\s*>')`. Open tags are safe.
See `mockProvider.ts` / `xmlToolParser.ts` for the established pattern.

## Adding a model

Edit `src/models.json`: `id`, `name`, `aliases` (what clients may send),
`fallback` (next model when this one is down), flags. The router builds
health-aware chains automatically; `/v1/models` merges upstream discoveries.

## Contributing

1. Fork → branch → small commits.
2. `bun run typecheck && bun run lint && bun run test` must pass.
3. New behaviour = new test (isolated file) + doc note where user-visible.
4. Keep the dashboard build-free (vanilla JS/CSS). The single external asset is
   Monaco on the Settings page: it is lazy-loaded from a CDN and **must** keep
   the plain-textarea fallback working, so an air-gapped host loses nothing but
   syntax highlighting.
