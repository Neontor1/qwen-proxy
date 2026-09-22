#Requires -Version 5.1
<#
.SYNOPSIS
  Wire Claude Code to the running gateway IN ONE SHOT:
  fetches /install/claude.ps1, runs it (User-scope env vars), sets the same
  vars for the CURRENT session and prints how to launch claude.
  -Test runs a one-shot "ping" through Claude Code at the end.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\connect-claude.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\connect-claude.ps1 -Port 31337 -Test
#>
param(
  [int]$Port = 33312,
  [string]$Model = 'claude-sonnet-4-5',
  [string]$Model2 = 'qwen3.8-max',
  [switch]$Test
)

$ErrorActionPreference = 'Stop'
$base = "http://127.0.0.1:$Port"

try {
  $null = Invoke-WebRequest "$base/health" -UseBasicParsing -TimeoutSec 3
}
catch {
  Write-Host ("gateway not reachable at {0}" -f $base) -ForegroundColor Red
  Write-Host 'start it first (another window):  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1' -ForegroundColor Yellow
  exit 1
}

$s = Join-Path $env:TEMP 'qg-claude.ps1'
Invoke-WebRequest "$base/install/claude.ps1" -OutFile $s -UseBasicParsing
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Mode Install -Model $Model

# current session gets the vars immediately (User-scope ones need a new window)
$env:ANTHROPIC_BASE_URL = $base   # SDK appends /v1/messages itself
$env:ANTHROPIC_API_KEY = 'sk-qwen-proxy'
$env:ANTHROPIC_MODEL = $Model
$env:ANTHROPIC_SMALL_FAST_MODEL = $Model
$env:OPENAI_BASE_URL = "$base/v1"
$env:OPENAI_API_KEY = 'sk-qwen-proxy'

# Claude Code validates the SELECTED model against its own catalog, so we keep a
# catalog name selected and remap the WIRE id to the gateway's live model via
# modelOverrides (the mechanism Claude Code itself suggests for provider ids).
$claudeDir = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null
$settingsFile = Join-Path $claudeDir 'settings.json'
$cfg = @{}
if (Test-Path $settingsFile) {
  (Get-Content $settingsFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value }
}
$overrides = @{}
foreach ($known in @('claude-sonnet-4-5','claude-sonnet-4-6','claude-opus-4-1','claude-opus-4-2','claude-opus-4-6','claude-haiku-4-5','claude-3-5-haiku-20241022','claude-3-5-haiku-latest')) {
  $overrides[$known] = $Model2
}
$cfg['modelOverrides'] = $overrides
$cfg | ConvertTo-Json -Depth 8 | Set-Content $settingsFile -Encoding UTF8
Write-Host ("modelOverrides written to {0} (catalog names -> {1})" -f $settingsFile, $Model2) -ForegroundColor DarkGray

Write-Host ''
Write-Host ("Claude Code is wired in THIS window. Claude asks for '{0}'; the gateway routes it to qwen3.8-max" -f $Model) -ForegroundColor Green
Write-Host '  one-shot:     claude -p "ping"' -ForegroundColor White
Write-Host '  interactive:  claude' -ForegroundColor White
Write-Host '  new windows:  vars already in User scope - just run claude' -ForegroundColor DarkGray
Write-Host ("  gateway logs: Get-Content server.log -Wait -Tail 20 (if started with -Background)" -f $Port) -ForegroundColor DarkGray

if ($Test) {
  Write-Host ''
  Write-Host '-- test run: claude -p "ping" --' -ForegroundColor Cyan
  claude -p 'ping'
}
