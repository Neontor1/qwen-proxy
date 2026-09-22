#Requires -Version 5.1
<#
.SYNOPSIS
  Start Qwen Proxy Gateway. Foreground by default (visible logs, Ctrl+C stops).
  -Background detaches it (PID -> server.pid, logs -> server.log).
  If something already listens on the port, says so and exits.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1 -Port 31337 -Background
#>
param(
  [int]$Port = 33312,
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
$base = "http://127.0.0.1:$Port"

function Test-Up {
  try { (Invoke-WebRequest "$base/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
  catch { $false }
}

if (Test-Up) {
  Write-Host ("gateway ALREADY running at {0} - use it or stop it first" -f $base) -ForegroundColor Yellow
  Write-Host '  stop background:  Get-Content server.pid | % { taskkill /T /PID $_ /F }' -ForegroundColor DarkGray
  Pop-Location
  exit 0
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
if (-not (Test-Path $bun)) {
  Write-Host 'bun not found. Install it:  powershell -c "irm bun.sh/install.ps1 | iex"   (then reopen terminal)' -ForegroundColor Red
  Write-Host 'or use Node:              set $env:QG_NODE=1 and re-run (uses npx tsx)' -ForegroundColor Yellow
  if (-not $env:QG_NODE) { Pop-Location; exit 1 }
}

$env:PORT = "$Port"
$env:OPEN_DASHBOARD_ON_START = 'false'

if ($Background) {
  if ($env:QG_NODE) {
    $exe = 'npx.cmd'; $exeArgs = @('tsx', 'src/cli.ts', 'start')
  } else {
    $exe = $bun; $exeArgs = @('run', 'src/cli.ts', 'start')
  }
  $p = Start-Process $exe -ArgumentList $exeArgs -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Root 'server.log') -RedirectStandardError (Join-Path $Root 'server.err.log')
  $p.Id | Set-Content (Join-Path $Root 'server.pid')
  $ok = $false
  for ($i = 0; $i -lt 45; $i++) { Start-Sleep -Seconds 1; if (Test-Up) { $ok = $true; break } }
  if (-not $ok) {
    Write-Host 'server did not start. server.log tail:' -ForegroundColor Red
    if (Test-Path (Join-Path $Root 'server.log')) { Get-Content (Join-Path $Root 'server.log') -Tail 20 | Write-Host }
    Pop-Location
    exit 1
  }
  Write-Host ("gateway UP in background (PID {0}): {1}/dashboard" -f $p.Id, $base) -ForegroundColor Green
  Write-Host '  stop:  Get-Content server.pid | % { taskkill /T /PID $_ /F }' -ForegroundColor DarkGray
  Write-Host '  log:   Get-Content server.log -Wait -Tail 20' -ForegroundColor DarkGray
}
else {
  Write-Host ("gateway starting in FOREGROUND at {0}  (Ctrl+C stops it)" -f $base) -ForegroundColor Green
  if ($env:QG_NODE) { & npx.cmd tsx src/cli.ts start }
  else { & $bun run src/cli.ts start }
}
Pop-Location
