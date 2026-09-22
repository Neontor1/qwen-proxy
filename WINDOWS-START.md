# Проверка на Windows — 5 минут

Готовый сборки-не-требует проект: TypeScript исполняется напрямую (Bun или Node),
ничего компилировать не нужно. Ниже — автопроверка одной командой и ручной маршрут.

---

## 0. Что привезти с собой

- Эту папку (`qwen-proxy/`) — распакуй куда угодно, напр. `C:\qwen-proxy` или `%USERPROFILE%\qwen-proxy`.
- Один из рантаймов:
  - **Bun** (рекомендуется): `powershell -c "irm bun.sh/install.ps1 | iex"`
  - или **Node.js LTS** (≥20): https://nodejs.org
- После установки рантайма **открой НОВОЕ окно терминала** (PATH обновляется не сразу).

## 1. Автопроверка (одна команда)

```powershell
cd C:\qwen-proxy
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1
```

Что делает: ставит зависимости → поднимает сервер в **mock-режиме** (аккаунты и сеть не нужны) →
прогоняет ~25 проверок (health, `qwen3.8-max`, OpenAI chat, Anthropic `/v1/messages` + SSE,
`count_tokens`, 5 страниц дашборда, Monaco, cookie-аккаунт, `verify`, ссылку-портал,
`/setup/claude-code`) → печатает `[PASS]/[FAIL]` и итог → останавливает сервер.

Полезные ключи:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Port 31337   # любой свой порт
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Stop          # стопнуть сервер после проверок
```

Скрипт чисто ASCII-английский специально: Windows PowerShell 5.1 читает `.ps1` без BOM
в системной кодировке (CP1251), и кириллица в коде ломала разбор. Диагностике язык не мешает.

## 1.1. Любой порт и «порт занят»

Порт задаётся четырьмя способами (по возрастанию приоритета для тебя):

```powershell
bun run src/cli.ts start --port 31337      # флаг CLI
$env:PORT = "31337"; bun run src/cli.ts start   # env (PowerShell)
# config.json:  "PORT": "31337"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Port 31337
```

Если порт занят **или исключён диапазоном Windows/Hyper-V** (частая причина «Is port 26405
in use?» при aparentemente свободном порте), гейтвей с `PORT_AUTO_FALLBACK=true` (default)
сам возьмёт следующий свободный, громко напишет это в логе и покажет правильный адрес
в баннере, в `/` и в `/setup/claude-code`. Отключить: `"PORT_AUTO_FALLBACK": false`.
Посмотреть исключённые диапазоны: `netsh interface ipv4 show excludedportrange protocol=tcp`.

Код возврата: `0` — всё зелёное, `2` — есть провалы, `1` — сервер не поднялся (лог рядом: `verify-windows.log`).

**По умолчанию скрипт НЕ останавливает сервер** после проверок — PID пишется в `server.pid`,
адрес печатается в конце. Остановить: `taskkill /T /PID <pid> /F` (pid из `server.pid`)
или перезапустить скрипт с `-Stop`. Проверил-и-забыл? Добавь `-Stop`.

## 1.5. Два окна — вся повседневность

Окно 1 (сервер):
```powershell
cd C:\qwenappi\qwen-proxy
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1            # форграунд, логи на экране
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1 -Background # фон: server.pid + server.log
```
Скрипт сам поймёт, если сервер уже поднят («ALREADY running»), сам найдёт bun (или Node через `$env:QG_NODE=1`).

Окно 2 (Claude Code):
```powershell
cd C:\qwenappi\qwen-proxy
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\connect-claude.ps1          # поставит env и подскажет команды
claude -p "ping"                                                                          # или просто: claude
```
`connect-claude.ps1` ставит переменные и в User-scope (через установщик), и в текущую сессию —
поэтому в этом же окне `claude` работает сразу, а в любых новых окнах — просто работает.
Ключи: `-Port N`, `-Model qwen3.8-flash`, `-Test` (сразу прогонит ping).

## 2. Ручной маршрут (если хочется глазами)

```powershell
cd C:\qwen-proxy
bun install            # или: npm install
bun run src/cli.ts start --mock     # или: npm run start:node -- --mock  (без bun)
```

В браузере:

| Куда | Зачем |
|---|---|
| http://localhost:26405/health | JSON `{"status":"ok","provider":"mock"…}` |
| http://localhost:26405/dashboard | дашборд; master key спросит — он в файле `master.key` или командой `bun run src/cli.ts key` |
| …/dashboard/accounts | три вкладки: 🔑 пароль, 🍪 куки (drag&drop экспорта Cookie-Editor), 🔗 ссылка-вход |
| …/dashboard/settings | Monaco-редактор config.json (офлайн — фолбэк-редактор) |

Быстрый смоук из PowerShell:

```powershell
irm http://localhost:26405/v1/models | % data | % id          # первой должна быть qwen3.8-max
irm -Method Post http://localhost:26405/v1/chat/completions -ContentType 'application/json' -Body '{"model":"qwen3.8-max","messages":[{"role":"user","content":"hi"}]}'
```

Тесты: `bun test` (94 теста, один процесс) — или `bash scripts/test.sh` в Git Bash/WSL.

## 3. Боевой режим (реальные аккаунты Qwen)

```powershell
bun run src/cli.ts start          # без --mock: provider=auto
```

- Добавь аккаунты: вкладка **Cookies** (экспорт Cookie-Editor с залогиненной chat.qwen.ai:
  обязательны `cna`, `token`, `ssxmod_itna`, `ssxmod_itna2`) — или вкладка **Login link**:
  создай ссылку, открой её в любом браузере/инкогнито, войди — аккаунт появится сам.
- Проверь сессию кнопкой **test** в строке аккаунта.

### Claude Code — одной командой

```powershell
$s="$env:TEMP\qg-claude.ps1"; iwr "http://localhost:26405/install/claude.ps1" -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s -Mode Install
claude -m qwen3-max "ping"
```

## 4. Если что-то пошло не так (Windows-специфика)

| Симптом | Лечение |
|---|---|
| `bun`/`node` «не является командой» | переустанови рантайм и **открой новое окно** терминала |
| `ExecutionPolicy` ругается | запускать с `-ExecutionPolicy Bypass` (как выше) |
| Порт 26405 занят | `-Port 26410` у скрипта / `env:PORT=26410` у сервера; или найди виновника: `netstat -ano \| findstr 26405` |
| SmartScreen/Defender предупредил | скрипты не подписаны — это ожидаемо для локального инструмента; запускай из распакованной папки, не из архива |
| Дашборд с другого компа в сети не открывается | сервер слушает `0.0.0.0`, но брандмауэр Windows может спросить разрешение при первом старте — разреши; для ссылки-портала задай `PUBLIC_URL=http://<твой-IP>:26405` |
| Bun поставился, но в PATH нет | путь обычно `%USERPROFILE%\.bun\bin` — добавь в PATH или перезалогинься |
| Cookie-аккаунт даёт пустой стрим при 200 | TLS-фингерпринт WAF (см. `docs/TROUBLESHOOTING.md`) — используй парольный вход или захват ссылкой с этого же IP |

Полные справочники: `README.md`, `docs/API.md`, `docs/TROUBLESHOOTING.md`, отчёт сверки с ТЗ — в корне рабочей папки проекта (`SVERKA-s-TZ.md` у меня, в архив не кладу).
