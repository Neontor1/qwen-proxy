#Requires -Version 5.1
<#
.SYNOPSIS
  Qwen Proxy Gateway self-check for Windows (ASCII-only on purpose: Windows
  PowerShell 5.1 reads BOM-less files in the system codepage).
  Installs dependencies, starts the server in MOCK mode (no accounts, no
  network needed) and verifies every major endpoint: health, model catalog
  (qwen3.8-max), OpenAI chat, Anthropic /v1/messages incl. SSE, count_tokens,
  all 5 dashboard pages, Monaco editor, cookie accounts, capture-link portal
  and the Claude Code setup endpoint. The server KEEPS RUNNING afterwards so you
  can click the dashboard right away; pass -Stop to shut it down at the end.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Port 31337 -Stop
#>
param(
  [int]$Port = 26405,
  [switch]$Stop   # stop the server after the checks (by default it KEEPS running)
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
$script:pass = 0
$script:fail = 0

function Check($Name, $Ok, $Extra = '') {
  if ($Ok) { $script:pass++; Write-Host ("  [PASS] {0} {1}" -f $Name, $Extra) -ForegroundColor Green }
  else { $script:fail++; Write-Host ("  [FAIL] {0} {1}" -f $Name, $Extra) -ForegroundColor Red }
}

function Test-PortFree([int]$p) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $p)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

function Req($Method, $Path, $Body = $null, $Headers = @{}) {
  try {
    $h = @{ 'Content-Type' = 'application/json' }
    foreach ($k in $Headers.Keys) { $h[$k] = $Headers[$k] }
    $p = @{ Method = $Method; Uri = "$script:Base$Path"; Headers = $h; TimeoutSec = 25; UseBasicParsing = $true }
    if ($null -ne $Body) {
      $json = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 8 -Compress }
      $p.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
    }
    $r = Invoke-WebRequest @p
    return @{ Status = [int]$r.StatusCode; Text = [string]$r.Content }
  }
  catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      return @{ Status = [int]$resp.StatusCode; Text = $sr.ReadToEnd() }
    }
    return @{ Status = 0; Text = $_.Exception.Message }
  }
}

Write-Host ''
Write-Host '=== Qwen Proxy Gateway - Windows self-check ===' -ForegroundColor Magenta

# -- pick a port: the requested one, or the next free one --------------------
$chosen = $Port
if (-not (Test-PortFree $chosen)) {
  $found = 0
  for ($i = 1; $i -le 50; $i++) { if (Test-PortFree ($Port + $i)) { $found = $Port + $i; break } }
  if ($found -eq 0) {
    Write-Host ("Port {0} and the next 50 are all busy/excluded. Free one first or pass -Port." -f $Port) -ForegroundColor Red
    Write-Host 'Windows excluded ranges: netsh interface ipv4 show excludedportrange protocol=tcp' -ForegroundColor Yellow
    Pop-Location; exit 1
  }
  Write-Host ("  [note] port {0} is busy/excluded - using {1} instead" -f $Port, $found) -ForegroundColor Yellow
  $chosen = $found
}
$script:Base = "http://127.0.0.1:$chosen"

# -- 0. runtime ---------------------------------------------------------------
$bun = Get-Command bun -ErrorAction SilentlyContinue
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $bun -and -not $node) {
  Write-Host 'Neither bun nor node found in PATH.' -ForegroundColor Red
  Write-Host '  Bun:  powershell -c "irm bun.sh/install.ps1 | iex"' -ForegroundColor Yellow
  Write-Host '  Node: https://nodejs.org (LTS >= 20)' -ForegroundColor Yellow
  Write-Host 'Then OPEN A NEW terminal window and run this script again.' -ForegroundColor Yellow
  Pop-Location; exit 1
}
if ($bun) { Check 'runtime found' $true ('bun ' + (bun --version)) }
else { Check 'runtime found' $true ('node ' + (node --version)) }

# -- 1. dependencies ----------------------------------------------------------
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Write-Host '  ... installing dependencies (first run)' -ForegroundColor Cyan
  if ($bun) { bun install | Out-Null } else { npm install --no-audit --no-fund | Out-Null }
}
Check 'dependencies installed' (Test-Path (Join-Path $Root 'node_modules'))

# -- 2. start the server (mock) -----------------------------------------------
$env:PROVIDER = 'mock'
$env:MOCK_DELAY_MS = '1'
$env:RATE_LIMIT_ENABLED = 'false'
$env:PORT = "$chosen"
$env:OPEN_DASHBOARD_ON_START = 'false'

if ($bun) { $exe = 'bun'; $exeArgs = @('run', 'src/cli.ts', 'start') }
else { $exe = 'npx.cmd'; $exeArgs = @('tsx', 'src/cli.ts', 'start') }
$outLog = Join-Path $Root 'verify-windows.log'
$errLog = Join-Path $Root 'verify-windows.err.log'
$proc = Start-Process -FilePath $exe -ArgumentList $exeArgs -WorkingDirectory $Root `
  -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$up = $false; $secs = 0
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1; $secs = $i + 1
  if ($proc.HasExited) { break }
  $r = Req 'GET' '/health'
  if ($r.Status -eq 200) { $up = $true; break }
}
Check ("server up on port {0}" -f $chosen) $up ("in {0}s" -f $secs)
if (-not $up) {
  Write-Host ''
  Write-Host 'Server did not start. Log tail:' -ForegroundColor Red
  if (Test-Path $outLog) { Get-Content $outLog -Tail 25 | Write-Host }
  Write-Host ''
  Write-Host 'Common causes: port busy (use -Port 31337); bun/node missing from PATH in THIS window;' -ForegroundColor Yellow
  Write-Host 'antivirus blocking listen; see WINDOWS-START.md section 4.' -ForegroundColor Yellow
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Pop-Location; exit 1
}

# -- 3. API --------------------------------------------------------------------
Write-Host ''
Write-Host '- API -' -ForegroundColor Cyan
$r = Req 'GET' '/health'
$j = $r.Text | ConvertFrom-Json
Check 'GET /health: ok + provider mock' ($r.Status -eq 200 -and $j.status -eq 'ok' -and $j.provider -eq 'mock')

$r = Req 'GET' '/v1/models'
$j = $r.Text | ConvertFrom-Json
$ids = @($j.data | ForEach-Object { $_.id })
Check 'GET /v1/models: qwen3.8-max present and first' ($ids -contains 'qwen3.8-max' -and $ids[0] -eq 'qwen3.8-max') ('models: ' + ($ids -join ', '))

$r = Req 'POST' '/v1/chat/completions' @{ model = 'qwen3.8-max'; messages = @(@{ role = 'user'; content = 'Say ok' }) }
Check 'POST /v1/chat/completions (mock, zero accounts) -> 200' ($r.Status -eq 200)

$r = Req 'POST' '/v1/messages' @{ model = 'claude-sonnet-4-5'; max_tokens = 64; messages = @(@{ role = 'user'; content = 'Say hi' }) }
$j = $r.Text | ConvertFrom-Json
Check 'POST /v1/messages (Anthropic) -> message/end_turn' ($r.Status -eq 200 -and $j.type -eq 'message' -and $j.stop_reason -eq 'end_turn')

$r = Req 'POST' '/v1/messages' @{ model = 'claude-sonnet-4-5'; max_tokens = 64; stream = $true; messages = @(@{ role = 'user'; content = 'Say hi' }) }
Check 'SSE Anthropic: message_start..message_stop, no [DONE]' `
  ($r.Status -eq 200 -and $r.Text -match 'event: message_start' -and $r.Text -match 'event: message_stop' -and $r.Text -notmatch '\[DONE\]')

$r = Req 'POST' '/v1/messages/count_tokens' @{ model = 'claude-sonnet-4-5'; messages = @(@{ role = 'user'; content = 'hello' }) }
$j = $r.Text | ConvertFrom-Json
Check 'POST /v1/messages/count_tokens -> input_tokens > 0' ($r.Status -eq 200 -and $j.input_tokens -gt 0)

# -- 4. dashboard ---------------------------------------------------------------
Write-Host ''
Write-Host '- Dashboard -' -ForegroundColor Cyan
foreach ($pg in @('/', '/accounts', '/logs', '/network', '/settings')) {
  $r = Req 'GET' ('/dashboard' + $pg)
  Check ('GET /dashboard' + $pg) ($r.Status -eq 200 -and $r.Text -match 'data-page=')
}
$r = Req 'GET' '/dashboard/settings'
Check 'Settings: Monaco host + fallback editor' ($r.Text -match 'cfg-monaco' -and $r.Text -match 'cfg-editor')
$r = Req 'GET' '/dashboard/accounts'
Check 'Accounts: 3 tabs (password / cookies / link)' ($r.Text -match 'data-tab="cookies"' -and $r.Text -match 'data-tab="link"')

# -- 5. master key, accounts, cookies, portal ------------------------------------
Write-Host ''
Write-Host '- Accounts, cookies, capture link -' -ForegroundColor Cyan
$null = Req 'GET' '/accounts'   # triggers master.key generation
$mkFile = Join-Path $Root 'master.key'
$mk = ''
if (Test-Path $mkFile) { $mk = (Get-Content $mkFile -Raw).Trim() }
Check 'master.key generated' ($mk -ne '')
$MH = @{ 'X-Master-Key' = $mk }

$r = Req 'GET' '/accounts' $null $MH
Check 'GET /accounts with master key -> 200' ($r.Status -eq 200)

$cookies = 'cna=w1; token=w2; ssxmod_itna=w3; ssxmod_itna2=w4; isg=w5'
$r = Req 'POST' '/accounts' @{ cookies = $cookies; label = 'win-check' } $MH
$j = $r.Text | ConvertFrom-Json
Check 'POST /accounts {cookies} -> 201 cookie account' ($r.Status -eq 201 -and $j.authKind -eq 'cookie' -and $j.cookieCount -eq 5)

$r = Req 'POST' '/accounts/verify' @{ cookies = $cookies } $MH
$j = $r.Text | ConvertFrom-Json
Check 'POST /accounts/verify -> ok + audit ok' ($r.Status -eq 200 -and $j.ok -eq $true -and $j.audit.ok -eq $true)

$r = Req 'POST' '/dashboard/api/capture' $null $MH
$j = $r.Text | ConvertFrom-Json
Check 'POST /dashboard/api/capture -> link /qwen?t=' ($r.Status -eq 200 -and $j.url -match '/qwen\?t=')
if ($j.url) {
  $path = $j.url -replace '^.*?/qwen', '/qwen'
  $r = Req 'GET' $path
  Check 'GET portal: rewritten html + status banner' ($r.Status -eq 200 -and $r.Text -match '__capture/status')
}

$r = Req 'GET' '/setup/claude-code'
$j = $r.Text | ConvertFrom-Json
Check 'GET /setup/claude-code -> powershell_command' ($r.Status -eq 200 -and $j.powershell_command -match 'claude.ps1')

# -- summary ---------------------------------------------------------------------
Write-Host ''
$color = if ($script:fail -gt 0) { 'Red' } else { 'Green' }
Write-Host ('=== RESULT: {0} PASS, {1} FAIL ===' -f $script:pass, $script:fail) -ForegroundColor $color
Write-Host ''
Write-Host 'Next steps by hand:' -ForegroundColor Cyan
Write-Host ('  dashboard:       ' + $script:Base + '/dashboard   (master key: file master.key or: bun run src/cli.ts key)') -ForegroundColor White
Write-Host ('  add cookies:     ' + $script:Base + '/dashboard/accounts  -> Cookies tab (drag & drop a Cookie-Editor export)') -ForegroundColor White
Write-Host ('  login link:      same page -> Login link tab -> open the link in any browser/incognito and sign in') -ForegroundColor White
Write-Host ('  Claude Code:     $s="$env:TEMP\qg-claude.ps1"; iwr "' + $script:Base + '/install/claude.ps1" -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s -Mode Install') -ForegroundColor White
Write-Host '  unit tests:      bun test' -ForegroundColor White
Write-Host ''

if ($Stop) {
  Write-Host 'Stopping the server...' -ForegroundColor DarkGray
  taskkill /T /PID $proc.Id /F 2>$null | Out-Null
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
else {
  # keep-alive by default: the whole point is to use the gateway right after
  $proc.Id | Set-Content (Join-Path $Root 'server.pid')
  Write-Host ''
  Write-Host ('SERVER LEFT RUNNING: ' + $script:Base + '  (PID ' + $proc.Id + ', log: verify-windows.log)') -ForegroundColor Green
  Write-Host ('  stop it with:  taskkill /T /PID ' + $proc.Id + ' /F') -ForegroundColor Yellow
  Write-Host '  or:          Get-Content server.pid | ForEach-Object { taskkill /T /PID $_ /F }' -ForegroundColor Yellow
  Write-Host '  or just re-run this script with -Stop' -ForegroundColor Yellow
}
Pop-Location
if ($script:fail -gt 0) { exit 2 } else { exit 0 }
