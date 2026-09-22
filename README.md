# Qwen Proxy Gateway / Qwen Proxy Gateway

**Self-hosted OpenAI-compatible proxy for Qwen (chat.qwen.ai)** with multi-account rotation,
SSE streaming, tool-call parsing and a web dashboard.
**Селф-хостед OpenAI-совместимый прокси для Qwen (chat.qwen.ai)** с ротацией аккаунтов,
SSE-стримингом, парсингом tool-calls и веб-дашбордом.

Аналог qwengate / qwen2api, но с полным циклом: аккаунты → сессии → стриминг → дашборд → инсталлеры.

---

## ✨ Возможности / Features

| | RU | EN |
|---|---|---|
| 🔌 | OpenAI-совместимый `/v1/chat/completions` (stream + non-stream) | OpenAI-compatible chat completions (SSE + JSON) |
| 🅰️ | Anthropic Messages API `/v1/messages` + `count_tokens` — Claude Code подключается напрямую | Anthropic Messages API (named SSE events, `tool_use`, `thinking`) |
| 🔁 | Ротация 5–10+ аккаунтов: round-robin, cooldown 120s, auto-failover | Multi-account round-robin with cooldown & failover |
| 🧠 | Tool calling: парсинг JSON/XML tool-вызовов из текста → OpenAI `tool_calls` | Tool calls parsed from text into OpenAI format |
| 🧹 | Content filter: вырезает think-теги и XML-артефакты на лету | Streaming content filter (think tags, XML artifacts) |
| 🖥️ | Веб-дашборд: Overview / Accounts / Logs / Network / Settings (live SSE, Monaco-редактор конфига) | 5-page dashboard with realtime SSE logs and a Monaco config editor |
| 🔑 | Bearer auth для API, master key для управления, AES-256-GCM пароли | Bearer auth, master key, encrypted passwords |
| 🍪 | Три способа подключить аккаунт: пароль, **куки** (Cookie-Editor/файл/вставка) и **ссылка-портал** с автозахватом сессии | Three onboarding paths: password, cookies (file/paste), capture-link auto-login |
| 🆕 | Актуальный каталог: **qwen3.8-max** (default), qwen3.8-flash, qwen3.7-max, coder-plus… | Up-to-date catalog: qwen3.8-max (default), qwen3.8-flash, … |
| 🪟 | Инсталлеры: PowerShell (Windows), bash (Linux/macOS), Docker | Installers for Windows, Linux/macOS, Docker |
| 🤖 | Готовые команды для Claude Code / OpenCode / Cursor | One-command setup for Claude Code / OpenCode / Cursor |
| 🧪 | Mock-режим: полный пайплайн без сети и аккаунтов (demo-аккаунт создаётся сам, в памяти) | Mock provider for offline demos & tests — zero-config |

## 🚀 Быстрый старт / Quick start

```bash
# 1. Зависимости / dependencies
bun install            # или: npm install (then use npm run start:node)

# 2. Демо без аккаунтов (mock-провайдер) / demo without accounts
PROVIDER=mock bun run src/cli.ts start
#    → http://localhost:26405/dashboard
#    аккаунты не нужны: gateway сам создаёт in-memory demo@mock.dev
#    (MOCK_DEMO_ACCOUNT=false отключает это поведение)

# 3. Боевой режим / production (порт — любой свободный)
bun run src/cli.ts start --port 31337     # или: $env:PORT=31337, или "PORT" в config.json
bun run src/cli.ts start          # или: qg start / bun start
#    → добавьте аккаунты Qwen: дашборд → Accounts, или:
qg accounts add you@example.com your-password
```

Проверка / smoke test:

```bash
curl -s http://localhost:26405/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-max","messages":[{"role":"user","content":"Hello!"}]}'
```

### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Mode Install
# обновление: -Mode Update   удаление: -Mode Uninstall
```

### Linux / macOS

```bash
./install.sh            # update | uninstall
# one-liner: curl -sSL https://your-server.com/install.sh | bash
```

### Docker

```bash
docker compose up -d --build
# данные (config, accounts, master.key) живут в volume qwen-data
```

## 👤 Три способа добавить аккаунт Qwen

1. **🔑 Пароль** — дашборд → Accounts, или `qg accounts add email password`.
   Пароль шифруется AES-256-GCM; логин HTTP, при капче — Playwright-браузер.
2. **🍪 Куки** — вкладка *Cookies*: перетащи экспорт Cookie-Editor (.json), выбери файл
   или вставь `Cookie:`-header / cookies.txt. Формат определяется на лету, чек-лист
   показывает обязательные куки (`cna`, `token`, `ssxmod_itna`, `ssxmod_itna2`),
   кнопка *⚡ Check session* делает живой probe до сохранения. Куки хранятся шифрованными;
   когда протухнут — кнопка *re-import* в строке аккаунта.
   ```bash
   curl -X POST http://localhost:26405/accounts -H "X-Master-Key: $KEY" -H 'Content-Type: application/json' \
     -d '{"cookies":"cna=…; token=…; ssxmod_itna=…; ssxmod_itna2=…","label":"main"}'
   curl -X POST http://localhost:26405/accounts/verify -H "X-Master-Key: $KEY" \
     -H 'Content-Type: application/json' -d '{"cookies":"…"}'   # dry-run probe
   ```
3. **🔗 Ссылка-портал** — вкладка *Login link*: гейтвей создаёт ссылку
   `http://<host>:26405/qwen/?t=…`. Открой её в **любом браузере или инкогнито** и войди
   в chat.qwen.ai как обычно: портал проксирует сайт через гейтвей и в момент логина
   сам перехватывает сессионные куки — аккаунт появляется в дашборде без единой вставки.
   Вкладка портала показывает свой статус-баннер, ссылка живёт 30 минут.

> Куки-сессии не обновляются сервером: при 401 аккаунт уходит в ошибки/auto-disable —
> просто сделай re-import. Подробнее про TLS-фингерпринт и пустые стримы — в
> `docs/TROUBLESHOOTING.md`.

## 🤖 Подключение Claude Code / Connecting Claude Code

Claude Code говорит по **Anthropic Messages API**, поэтому гейтвей реализует
`POST /v1/messages` (включая именованные SSE-события, `tool_use`-блоки,
`thinking`-блоки и `POST /v1/messages/count_tokens`). Одна команда в PowerShell
(при запущенном гейтвее) — и Claude Code настроен:

```powershell
# Windows / PowerShell — одной командой
$s="$env:TEMP\qg-claude.ps1"; iwr "http://localhost:26405/install/claude.ps1" -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s -Mode Install
```

```bash
# Linux / macOS — одной командой
curl -fsSL http://localhost:26405/install/claude.sh | bash -s -- install
```

Скрипт пропишет `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` (+ `OPENAI_*`) и его же
можно получить готовым из API: `curl -s http://localhost:26405/setup/claude-code | jq .powershell_command`.
Откат — `-Mode Uninstall`.

```bash
claude -m qwen3-max "Write a Python function"      # или просто: claude
```

Модели Claude в запросах не обязательно переименовывать: `claude-sonnet-4-5`,
`claude-3-5-sonnet-latest`, `claude-3-5-haiku-*` и т.п. уже замаплены на Qwen
в `src/models.json` (алиасы). Неизвестный id по умолчанию маршрутизируется на
модель по умолчанию с заголовком `X-Model-Routed-From`; при `STRICT_MODELS=true`
вернётся `400` со списком доступных моделей.

Также есть `/setup/opencode` и `/setup/cursor` с готовыми конфигами.

## ⚙️ Конфигурация / Configuration

`config.json` создаётся при первом старте; все поля перекрываются env-переменными
(`PORT`, `API_KEY`, `PROVIDER`, … или с префиксом `QP_`). Правки из дашборда применяются
на лету (hot reload). Полный справочник — в `config.example.jsonc`.

| Параметр | Default | Описание / Description |
|---|---|---|
| `PORT` | `26405` | Порт HTTP (любой свободный; также `--port N`, `$env:PORT`) / HTTP port |
| `PORT_AUTO_FALLBACK` | `true` | Порт занят/исключён ОС → взять следующий свободный и показать его в баннере |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | `""` | Bearer token для `/v1` (пусто = открыто) / bearer token for `/v1` |
| `MASTER_KEY` | `""` | Ключ дашборда/управления (пусто = генерируется в `master.key`) |
| `PROVIDER` | `auto` | `auto` / `real` / `mock` |
| `QWEN_BASE_URL` | `https://chat.qwen.ai` | Upstream base URL |
| `BROWSER` | `chromium` | Playwright engine для browser-login fallback |
| `BROWSER_LOGIN` | `false` | Разрешить вход через браузер при капче |
| `SESSION_POOL_SIZE` | `5` | Размер пула сессий / session pool size |
| `TOOL_CALLING` | `true` | Парсинг tool calls из текста |
| `CLEAN_OUTPUT` | `true` | Фильтрация think-тегов и XML-артефактов |
| `STREAMING_MODE` | `auto` | `auto` / `on` / `off` |
| `STRICT_MODELS` | `false` | `true` = отклонять неизвестные модели (400) вместо тихого fallback |
| `MOCK_DEMO_ACCOUNT` | `true` | В mock-режиме создавать in-memory `demo@mock.dev`, если аккаунтов нет |
| `RATE_LIMIT_COOLDOWN_MS` | `120000` | Cooldown аккаунта после rate limit |
| `RETRY_MAX_ATTEMPTS` | `3` | Попытки с failover на другой аккаунт |
| `HEARTBEAT_INTERVAL_MS` | `15000` | SSE keep-alive интервал |
| `STREAM_IDLE_TIMEOUT_MS` | `120000` | Закрытие молчащего стрима |
| `MAX_ACCOUNT_ERRORS` | `5` | Ошибок подряд до auto-disable |
| `RATE_LIMIT_ENABLED/RPM/BURST` | `true/60/20` | Token-bucket лимит по IP |
| `SAVE_REQUEST_LOGS` | `false` | Писать логи в `logs/requests.jsonl` |
| `NETWORK_DEBUG` | `false` | Capture исходящих вызовов (страница Network) |
| `LOG_LEVEL` | `info` | `debug/info/warn/error` |
| `WORKERS` | `1` | Число процессов (cluster); `-1` = все ядра |
| `OPEN_DASHBOARD_ON_START` | `false` | Открыть браузер при старте |
| `ACCOUNTS` | `[]` | Сид-аккаунты `{email,password}` (копируются в accounts.json) |

## 🏗️ Архитектура / Architecture

```
HTTP (OpenAI / Anthropic format)         chat.qwen.ai (SSE)
        │                                        ▲
        ▼                                        │
┌───────────────────────────────────────────────────────────┐
│ /v1/chat/completions ┐                                    │
│ /v1/messages         ┴→ validate (Zod) → model router     │
│   → account rotation (round-robin + cooldown + failover)  │
│   → session pool (login / token refresh / browser login)  │
│   → provider stream → tool parser → content filter        │
│   → SSE writer (heartbeat, idle timeout, [DONE])          │
├───────────────────────────────────────────────────────────┤
│ Dashboard (/dashboard): Overview · Accounts · Logs ·      │
│                         Network · Settings  (SSE live)    │
├───────────────────────────────────────────────────────────┤
│ Stores: logStore · monitorStore · networkDebug ·          │
│         tokenCache · modelHealth                          │
└───────────────────────────────────────────────────────────┘
```

Runtime: **Bun** (приоритет) или **Node.js ≥ 20** (`npm run start:node`).
Runtime: **Bun** (priority) or **Node.js ≥ 20** (`npm run start:node`).

## 🔐 Безопасность / Security

- `API_KEY` — bearer token для `/v1/*`; `MASTER_KEY` — для `/accounts*` и дашборда.
- Пароли аккаунтов шифруются **AES-256-GCM** (ключ = scrypt от master key).
- Rate limiting по IP (token bucket); Zod-валидация всех входов.
- В production ставьте за reverse proxy с TLS (см. `docs/DEPLOYMENT.md`).
- Никогда не коммитьте `config.json`, `accounts.json`, `master.key` (уже в `.gitignore`).

## 🧪 Тесты / Tests

```bash
bun run test          # юниты + интеграция (по процессу на файл — штатный режим)
bun test              # то же самое одним процессом (изоляция синглтонов учтена)
bun run smoke         # e2e против ЗАПУЩЕННОГО сервера (BASE_URL=..., MASTER_KEY=...)
```

## 📚 Документация / Docs

- [`docs/API.md`](docs/API.md) — полный API reference
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production: systemd, nginx/caddy, Docker
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — структура кода, контрибьют, соглашения
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — частые проблемы и решения

## ⚠️ Дисклеймер

Неофициальный проект, не аффилирован с Alibaba/Qwen. Use at your own risk;
upstream API может меняться — эндпоинты реального провайдера переопределяются
env-переменными (`QWEN_AUTH_PATH`, `QWEN_CHAT_SEND_PATH`, …).

## License

MIT
