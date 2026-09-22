# API Reference — Qwen Proxy Gateway

Base URL: `http://<host>:<port>` (default port `26405`).
Auth: `/v1/*` — `Authorization: Bearer <API_KEY>` **or** `x-api-key: <API_KEY>`
(the latter is what Anthropic clients such as Claude Code send); both are only
enforced when `API_KEY` is set.
Management — `X-Master-Key: <MASTER_KEY>` header (or `?key=` / dashboard cookie).

Two wire dialects are served by the same pipeline (rotation, failover, filters,
tool parsing, metrics): OpenAI Chat Completions and Anthropic Messages.

---

## OpenAI-compatible

### POST /v1/chat/completions

OpenAI Chat Completions format. Supports `stream: true` (SSE), tool definitions,
system/user/assistant/tool messages, multimodal content parts (text is forwarded,
non-text parts are described in the prompt).

Request:

```json
{
  "model": "qwen3-max",
  "messages": [
    { "role": "system", "content": "You are terse." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 1024,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Current weather",
        "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
      }
    }
  ],
  "enable_search": false,
  "thinking": true
}
```

Non-streaming response: standard `chat.completion` object; `message` may include
`reasoning_content` (thinking trace) and `tool_calls`:

```json
{
  "id": "chatcmpl-…", "object": "chat.completion", "created": 1730000000,
  "model": "qwen3-max",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "…",
      "tool_calls": [{
        "id": "call_…", "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 21, "completion_tokens": 30, "total_tokens": 51 }
}
```

Streaming response: `text/event-stream`, `data:` chunks of `chat.completion.chunk`,
heartbeat comments (`: keep-alive`) every `HEARTBEAT_INTERVAL_MS`, terminator
`data: [DONE]`. Tool calls arrive as `delta.tool_calls[]` entries.

Errors (OpenAI shape): `400` validation, `401` bad API key, `429` client rate limit or
all accounts cooling down (`Retry-After` header), `502/503` upstream/rotation failure.

### GET /v1/models

```json
{ "object": "list", "data": [ { "id": "qwen3-max", "object": "model", "created": 1700000000, "owned_by": "qwen" } ] }
```

Catalog comes from `src/models.json` (aliases: `gpt-4o`, `claude-sonnet-4-5`, `qwen-coder`, …)
and is merged with the live upstream list when a session is available.

## Anthropic Messages API

### POST /v1/messages

Anthropic Messages format — this is what **Claude Code** calls when
`ANTHROPIC_BASE_URL` points at the gateway. The request is translated into the
OpenAI shape, run through the regular pipeline, and translated back.

Request:

```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 1024,
  "system": "You are terse.",
  "messages": [
    { "role": "user", "content": "Hello!" },
    { "role": "assistant", "content": [
      { "type": "text", "text": "Let me check." },
      { "type": "tool_use", "id": "call_1", "name": "get_weather", "input": { "city": "Paris" } }
    ]},
    { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "call_1", "content": "Sunny, 21C" }
    ]}
  ],
  "tools": [
    { "name": "get_weather", "description": "Current weather",
      "input_schema": { "type": "object", "properties": { "city": { "type": "string" } } } }
  ],
  "tool_choice": { "type": "auto" },
  "thinking": { "type": "enabled", "budget_tokens": 1024 },
  "stream": true
}
```

Response (`stream: false`):

```json
{
  "id": "msg_1a2b3c…",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5",
  "content": [
    { "type": "thinking", "thinking": "…", "signature": "" },
    { "type": "text", "text": "Sunny and 21C in Paris." },
    { "type": "tool_use", "id": "call_…", "name": "get_weather", "input": { "city": "Paris" } }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 42, "output_tokens": 18 }
}
```

Streaming (`stream: true`) emits named SSE events in Anthropic order:
`message_start` → `ping` → `content_block_start` → `content_block_delta`
(`text_delta` / `thinking_delta` / `input_json_delta`) → `content_block_stop` →
`message_delta` (stop_reason + output tokens) → `message_stop`. There is **no**
`data: [DONE]` sentinel — the stream simply closes, as in the real API.

Conversion notes:

| Anthropic | Gateway behaviour |
|---|---|
| top-level `system` (string or blocks) | prepended as an OpenAI `system` message |
| `tool_use` / `tool_result` blocks | assistant `tool_calls` / `role: "tool"` messages |
| `image` blocks (base64 or url) | OpenAI `image_url` parts (data URI) |
| `input_schema` | OpenAI `function.parameters` |
| `tool_choice: auto/any/none/tool` | `auto` / `required` / `none` / `{function:{name}}` |
| `stop_sequences` | `stop` |
| `thinking: {type:"enabled"}` | Qwen thinking on; reasoning returned as `thinking` blocks |
| `thinking` / `redacted_thinking` input blocks | dropped (regenerated per turn) |
| `finish_reason` | `stop`→`end_turn`, `tool_calls`→`tool_use`, `length`→`max_tokens` |
| Claude model ids | mapped through `src/models.json` aliases (e.g. `claude-sonnet-4-5`→`qwen3-max`) |

Errors use the Anthropic envelope: `{"type":"error","error":{"type":"…","message":"…"}}`
with `invalid_request_error` / `authentication_error` / `rate_limit_error` / `api_error`.

### POST /v1/messages/count_tokens

Local estimate (no upstream call), as Claude Code invokes it before prompting:

```json
{ "model": "claude-sonnet-4-5", "system": "You are terse.", "messages": [{ "role": "user", "content": "Hello" }] }
```
→ `{ "input_tokens": 17 }`

## Model routing headers

Unknown or aliased model ids are resolved by the router. Every response then carries:

- `X-Model-Routed-From: <requested id>`
- `X-Model-Resolved: <id actually used>`

Set `STRICT_MODELS=true` to reject unknown ids with `400` and the list of known
models instead of falling back silently.

## Health

### GET /health · GET /ping

```json
{
  "status": "ok", "uptimeSec": 123, "provider": "real", "port": 26405,
  "accounts": { "total": 3, "active": 2, "cooldown": 1, "disabled": 0 },
  "inflight": 0,
  "models": { "qwen3-max": "healthy" },
  "sessions": { "size": 2, "max": 5 },
  "requests": { "total": 42, "errors": 1, "perMin": 3.2 }
}
```

## Account management (master key)

Three credential kinds are supported: `password` (classic login), `cookie`
(captured `Cookie:` header) and accounts created by the capture-link portal
(`source: "capture"`).

### POST /accounts

```json
{ "email": "you@example.com", "password": "secret" }
```
or a cookie account (email/label optional — synthesised when absent):

```json
{ "cookies": "cna=…; token=…; ssxmod_itna=…; ssxmod_itna2=…", "label": "work laptop" }
```
`cookies` accepts a raw `Cookie:` header, a Cookie-Editor JSON export,
a `{name: value}` object, `name=value` lines or Netscape cookies.txt.
Response `201`: `{id, email, status, authKind, cookieCount, audit, droppedCookies, warnings}`.

### POST /accounts/verify

Dry-run: parse → domain filter → required-cookie audit → live probe against
chat.qwen.ai (or the mock provider). Nothing is stored.
`→ {ok, message, format, cookieCount, cookieNames, masked, droppedCookies, audit, warnings}`

### PATCH /accounts/:id

`{enabled?, clearCooldown?}` plus `{cookies: "…"}` to re-import a fresh session
for a cookie account (invalidates its pooled session).

### Capture-link portal (login through the gateway)

| Endpoint | Auth | Назначение |
|---|---|---|
| `POST /dashboard/api/capture` | master key | создать тикет → `{ticket, url, expiresInSeconds}` |
| `GET /dashboard/api/capture/:ticket` | master key | статус для поллинга дашборда |
| `DELETE /dashboard/api/capture/:ticket` | master key | отменить ссылку |
| `GET /qwen/?t=<ticket>` | public | сам портал: проксирует chat.qwen.ai, переписывает origin/`/api/` пути, внедряет статус-баннер |
| `GET /qwen/__capture/status` | cookie тикета | `{status: pending|captured|expired, email, accountId, cookieNames, expiresInSeconds}` |
| `/api/*` | cookie тикета | проксируется на upstream только при живом тикете (иначе 404) |

Как только upstream-логин успешен, сессионные куки сохраняются (шифрованно) и
создаётся cookie-аккаунт с `source: "capture"`; повторный захват того же email
обновляет куки существующего аккаунта.



| Method & path | Purpose |
|---|---|
| `GET /accounts` | List accounts (status, cooldown, usage; no secrets) |
| `POST /accounts` | Add `{ "email", "password" }` → 201 |
| `DELETE /accounts/:id` | Remove account |
| `PATCH /accounts/:id` | `{ "enabled": bool }`, `{ "clearCooldown": true }` |
| `POST /accounts/:id/test` | Verify credentials against the provider |

The same API is mounted under `/dashboard/api/accounts*` for the UI.

## Client setup

### GET /setup/claude-code

```json
{
  "powershell_command": "$script = Join-Path $env:TEMP \"qwen-proxy-claude.ps1\"; Invoke-WebRequest \"http://…/install/claude.ps1\" -OutFile $script; powershell -NoProfile -ExecutionPolicy Bypass -File $script -Mode Install",
  "bash_command": "curl -fsSL http://…/install/claude.sh | bash -s -- install",
  "curl_example": "curl -X POST http://…/v1/chat/completions …",
  "config": { "endpoint": "http://…/v1", "api_key": "…", "available_models": ["qwen3-max", "…"] }
}
```

### GET /setup/opencode · GET /setup/cursor

Ready-made config snippets (OpenCode JSON / Cursor settings instructions).

### GET /install/claude.ps1 · GET /install/claude.sh

Generated configurator scripts with the current endpoint & API key baked in.
They set `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`
(user scope on Windows, managed block in `~/.bashrc`/`~/.zshrc` on Unix).
Static copies live in `install/`.

## Dashboard

Pages (HTML): `/dashboard`, `/dashboard/accounts`, `/dashboard/logs`,
`/dashboard/network`, `/dashboard/settings`.
Login: `POST /dashboard/login { "key": MASTER_KEY }` sets an HttpOnly cookie.

JSON API (master key): `/dashboard/api/overview`, `/accounts…`, `/logs`,
`/network`, `/network/:id`, `/network/clear`, `/config`, `/config/raw`,
`PUT /config` (`{raw}` or `{patch}`, validated + hot-reloaded), `/sessions`,
and `GET /dashboard/api/stream` — SSE feed of request logs + system logs.

## CLI

```
qg start [--port N] [--host H] [--browser B] [--mock] [--workers N] [--open]
qg accounts list|add|rm|test
qg config get|set KEY=VALUE|path
qg key            # print master key
qg doctor         # environment diagnostics
qg version|help
```
