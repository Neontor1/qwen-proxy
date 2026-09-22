# Troubleshooting — Qwen Proxy Gateway

## Quick diagnostics

```bash
qg doctor                     # runtime, config, provider, accounts, playwright
curl -s localhost:26405/health | jq   # accounts / models / sessions snapshot
LOG_LEVEL=debug qg start      # verbose pipeline logs
```

Dashboard → Network page (enable `NETWORK_DEBUG`) shows every outbound call to
chat.qwen.ai with status/duration — the fastest way to see upstream rejections.

---

## "Cannot decrypt stored password — MASTER_KEY changed"

Passwords in `accounts.json` are sealed with the master key. If you replaced
`MASTER_KEY` (or deleted `master.key` and a new one was generated), old accounts
can no longer be decrypted.

**Fix:** restore the original key, or remove & re-add the accounts
(`qg accounts rm <id>` / dashboard). Keep `master.key` in backups together with
`accounts.json` — they are a pair.

## Dashboard asks for a master key I never set

When `MASTER_KEY` is empty the gateway generates one on first start and stores it
in `master.key` (data dir). Retrieve it:

```bash
qg key
```

Or set your own in `config.json` / env and restart.

## 429 from the gateway ("All accounts are cooling down")

Every account hit upstream rate limits / risk control. Check cooldowns on
Dashboard → Accounts (timer shown per row); wait `RATE_LIMIT_COOLDOWN_MS`,
press **clear cd**, or add more accounts. `Retry-After` header tells how long.

## 502 "Upstream request failed after N attempt(s)"

All rotation attempts failed. Look at the error text:

- *risk control / rgv587 / aliyun_waf* → your IP is flagged by Aliyun WAF.
  Try another network/IP, enable `BROWSER_LOGIN=true` (needs Playwright browsers:
  `bunx playwright-core install chromium`), or reduce request rate.
- *invalid token / 401* → account password changed or captcha on the web login;
  use **test** button on the Accounts page.
- *network error* → DNS/egress problem from the host.

## Login works in browser but fails from the gateway

chat.qwen.ai may require captcha for datacenter IPs. Options:
1. `BROWSER_LOGIN=true` + installed chromium → real-browser login fallback.
2. Log in manually in a browser and… no token import yet — use a residential IP.

## SSE stream stalls or never finishes behind nginx/proxy

Proxy buffering breaks SSE. Set `proxy_buffering off;` (nginx) or
`flush_interval -1` (Caddy) — see `docs/DEPLOYMENT.md`. The gateway itself sends
heartbeat comments every `HEARTBEAT_INTERVAL_MS` and closes idle streams after
`STREAM_IDLE_TIMEOUT_MS`.

## `Method Not Allowed` (405) или `no chat id` на боевых запросах

Веб-API chat.qwen.ai **меняет маршруты без предупреждения** (например, создание
чата переезжало с `/api/v2/chats/` на `/api/v2/chats/new`, а комплеции — на
`/api/v2/chat/completions?chat_id=…`), плюс шлёт `version` — идентификатор сборки
SPA, который устаревает каждые несколько недель.

Гейтвей теперь переживает это автоматически: при 404/405 или «200 без chat id»
пробует следующий известный вариант пути и пишет WARN в лог. Если и все варианты
протухли — поймай в DevTools → Network реальные запросы своего браузера
(`chats/new`, `completions?chat_id=…`, заголовок `version`) и переопредели точечно:

```powershell
$env:QWEN_CREATE_CHAT_PATH = '/api/v2/chats/new'
$env:QWEN_CHAT_SEND_PATH   = '/api/v2/chat/completions?chat_id={chat_id}'   # плейсхолдер {chat_id} обязателен
$env:QWEN_WEB_VERSION      = '0.2.81'
bun run src/cli.ts start
```

### Пустой стрим за ~1 мс (bytes=0) на нагрузке Claude Code

Веб-API молча degrader'ит «тяжёлые» payload'ы: включённый thinking и/или промпт с
преамбулой инструментов (у Claude Code 30+ tools). Гейтвей теперь сам лезет по
лесенке: полный payload → без thinking → без thinking и без tool-преамбулы,
и пишет WARN, какой вариант наконец застримил:

```
upstream returned an empty stream (thinking=true, tools=true) - retrying with a reduced payload
```

Если стримит только третий вариант — Claude Code через гейтвей работает в
chat-режиме без tool-calls (ограничение upstream, не гейтвея); обычные диалоги и
OpenCode/Cursor с инструментами продолжают стримить как обычно.

Побочный эффект любых 5 ошибок подряд — аккаунт auto-disabled и модель помечена
DOWN: после починки включи аккаунт кнопкой *enable* в дашборде или
`PATCH /accounts/:id {"enabled":true,"clearCooldown":true}`; здоровье модели
сбросится само после первого успешного запроса.

## Cookie-аккаунт: пустые стримы или 401 сразу после импорта

- **Обязательные куки:** `cna`, `token`, `ssxmod_itna`, `ssxmod_itna2`
  (плюс рекомендуется `isg`, `tfstk`). Чек-лист во вкладке *Cookies* и
  `POST /accounts/verify` покажут, чего не хватает.
- **Куки протухли** (обычно дни/недели): upstream отвечает 401 → аккаунт копит ошибки.
  Лечение: кнопка *re-import* в строке аккаунта или `PATCH /accounts/:id {cookies}`.
- **Пустой SSE-стрим при 200** (тело приходит, событий нет): перед chat.qwen.ai стоит
  WAF, который снимает TLS-фингерпринт (JA3/JA4). Node/Bun-клиент отличается от Chrome,
  и WAF молча деградирует ответ. Обход: использовать парольный аккаунт (HTTP-логин с
  baxia-заголовками) или держать сессию, захваченную ссылкой-порталом с того же IP/UA.
- **Экспорт не из того домена:** парсер отбрасывает куки чужих доменов и показывает
  `(+N other-domain skipped)`; если обязательных кук не осталось — берёт всё и предупреждает.

## Ссылка-портал не открывается или протух

- Ссылка содержит адрес из `PUBLIC_URL` (или `HOST:PORT`): за reverse proxy задай
  `PUBLIC_URL=https://gw.example.com`, иначе браузер уйдёт на `localhost:26405`.
- Портал должен быть доступен из браузера пользователя напрямую (куки ставятся на
  домен гейтвея); через строгий CSP/прокси без cookie-поддержки захват не сработает.
- Тикет живёт 30 минут и одноразовый по сути: после `captured` новая попытка входа
  просто обновит куки того же аккаунта.
- `/api/*` проксируется **только** с живой кукой тикета — это защита от открытого прокси.

## Claude Code ignores the gateway

Claude Code talks the **Anthropic Messages API**, so the gateway serves
`POST /v1/messages` (+ `/v1/messages/count_tokens`) and accepts the
`x-api-key` header it sends. Check the endpoint is alive:

```bash
curl -s -X POST http://localhost:26405/v1/messages \
  -H 'Content-Type: application/json' -H 'x-api-key: anything' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
# → {"id":"msg_…","type":"message", …}   (404 here means an outdated build)
```

Env vars are read at process start: reopen the terminal after running the
setup script. Verify:

```bash
echo $ANTHROPIC_BASE_URL   # should be http://<host>:26405/v1
claude -m qwen3-max "ping"
```

**`400 Unknown model`** — the client sent a model id the catalog does not know
and `STRICT_MODELS=true`. Either add an alias in `src/models.json` or set
`STRICT_MODELS=false` (default), which routes unknown ids to the default model
and advertises it via `X-Model-Routed-From`.

On Windows the installer sets *User* scope variables — log off/on or restart the
terminal (or run `install/claude.ps1` again in the same shell with
`[Environment]::SetEnvironmentVariable(..., "Process")` tweaks).

## Port already in use

`qg start --port 26410` or set `PORT` in config/env. Docker users: remap in
`docker-compose.yml`.

## Running under Node instead of Bun

Everything works on Node ≥ 20 via tsx (`npm run start:node`), including SSE and
crypto. Differences: slightly higher latency; `node:cluster` fully supported
(Bun cluster support is best-effort).

## Playwright errors ("browser not found")

Only needed for `BROWSER_LOGIN` fallback. Install:

```bash
bunx playwright-core install chromium     # or: npx playwright-core install chromium
```

Docker: rebuild with `--build-arg WITH_BROWSER=1`.

## Mock mode for demos/tests

```bash
PROVIDER=mock qg start
```

Special mock accounts: `*@fail.*` (login error), `*@ratelimit.*` (429 once/30s),
`*@flaky.*` (every other request 500), `*@slow.*` (10× latency) — perfect for
exercising failover, cooldown and retry paths without touching real accounts.

## Logs & state locations

- System log: `logs/system.log` (+ console)
- Request log: `logs/requests.jsonl` (when `SAVE_REQUEST_LOGS=true`)
- State: `config.json`, `accounts.json`, `sessions.json`, `master.key`
- Override the data dir: `QWEN_PROXY_HOME=/var/lib/qwen-proxy`

## Something else?

Enable `LOG_LEVEL=debug` + `NETWORK_DEBUG=true`, reproduce, and inspect
Dashboard → Network / Logs. The debug stream shows account selection, cooldown
decisions, parser actions and every upstream HTTP exchange.
