# ============================================================
#  Qwen Proxy Gateway - Windows installer (PowerShell)
#  Usage:
#    powershell -ExecutionPolicy Bypass -File install.ps1 -Mode Install
#    powershell -ExecutionPolicy Bypass -File install.ps1 -Mode Update
#    powershell -ExecutionPolicy Bypass -File install.ps1 -Mode Uninstall
#  One-liner (remote):
#    powershell -ExecutionPolicy Bypass -c "irm https://your-server.com/install.ps1 | iex"
# ============================================================
param(
    [ValidateSet("Install", "Update", "Uninstall")]
    [string]$Mode = "Install",
    [string]$RepoUrl = $env:QG_REPO_URL,
    [string]$InstallDir = "$HOME\qwen-proxy",
    [switch]$SkipBrowser
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($msg)  { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[x] $msg" -ForegroundColor Red }

# ---------- checks ----------
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-Bun {
    if (Get-Command bun -ErrorAction SilentlyContinue) { Write-Ok "Bun found: $(bun --version)"; return }
    Write-Step "Installing Bun runtime..."
    powershell -NoProfile -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex"
    $env:Path = "$HOME\.bun\bin;$env:Path"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Write-Err "Bun installation failed. Install manually: https://bun.sh"; exit 1
    }
    Write-Ok "Bun installed: $(bun --version)"
}

function Set-Config {
    param([string]$Dir)
    $cfg = Join-Path $Dir "config.json"
    if (-not (Test-Path $cfg)) {
        Write-Step "Creating config.json with defaults..."
        @'
{
  "PORT": "26405",
  "HOST": "0.0.0.0",
  "API_KEY": "",
  "BROWSER": "chromium",
  "TOOL_CALLING": true,
  "CLEAN_OUTPUT": true,
  "STREAMING_MODE": "auto",
  "RATE_LIMIT_COOLDOWN_MS": 120000,
  "RETRY_MAX_ATTEMPTS": 3,
  "HEARTBEAT_INTERVAL_MS": 15000,
  "SESSION_POOL_SIZE": 5,
  "SAVE_REQUEST_LOGS": false,
  "OPEN_DASHBOARD_ON_START": false,
  "ACCOUNTS": []
}
'@ | Set-Content -Path $cfg -Encoding UTF8
        Write-Ok "config.json created"
    } else {
        Write-Ok "config.json already exists - keeping it"
    }
}

function New-StartScript {
    param([string]$Dir)
    $bat = Join-Path $Dir "start.bat"
    @'
@echo off
cd /d "%~dp0"
bun run src/cli.ts start
pause
'@ | Set-Content -Path $bat -Encoding ASCII
    Write-Ok "start.bat created"
}

function New-DesktopShortcut {
    param([string]$Dir)
    try {
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut([IO.Path]::Combine($ws.SpecialFolders("Desktop"), "Qwen Proxy Gateway.lnk"))
        $sc.TargetPath = Join-Path $Dir "start.bat"
        $sc.WorkingDirectory = $Dir
        $sc.Description = "Qwen Proxy Gateway"
        $sc.Save()
        Write-Ok "Desktop shortcut created"
    } catch {
        Write-Warn2 "Could not create desktop shortcut: $($_.Exception.Message)"
    }
}

# ---------- modes ----------
if ($Mode -eq "Uninstall") {
    Write-Step "Uninstalling Qwen Proxy Gateway..."
    $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Qwen Proxy Gateway.lnk"
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
    if (Test-Path $InstallDir) {
        $keep = Join-Path $env:TEMP "qwen-proxy-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -Path $InstallDir -Destination $keep -Recurse -Force
        Write-Warn2 "Data backed up to $keep"
        Remove-Item $InstallDir -Recurse -Force
    }
    Write-Ok "Uninstalled (config backup kept in TEMP)"
    exit 0
}

Write-Host "==============================================" -ForegroundColor Magenta
Write-Host "   Qwen Proxy Gateway - Windows installer" -ForegroundColor Magenta
Write-Host "==============================================" -ForegroundColor Magenta

if (-not (Test-Admin)) {
    Write-Warn2 "Not running as administrator - continuing (admin only needed for system-wide tweaks)"
}

Install-Bun

if ($Mode -eq "Update") {
    if (-not (Test-Path $InstallDir)) { Write-Err "Not installed at $InstallDir - run -Mode Install first"; exit 1 }
    Write-Step "Updating installation in $InstallDir..."
    Push-Location $InstallDir
    if (Test-Path ".git") { git pull --ff-only } else { Write-Warn2 "No git repo - only refreshing dependencies" }
    bun install
    if (-not $SkipBrowser) { bunx playwright-core install chromium }
    Pop-Location
    Write-Ok "Updated"
    exit 0
}

# Install
Write-Step "Installing to $InstallDir"
if (Test-Path $InstallDir) { Write-Warn2 "Directory exists - will reuse it" } else { New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null }

if ($RepoUrl) {
    Write-Step "Cloning $RepoUrl..."
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Push-Location $InstallDir; git pull --ff-only; Pop-Location
    } else {
        git clone $RepoUrl $InstallDir
    }
} else {
    Write-Warn2 "No -RepoUrl given: expecting the project files to already be in $InstallDir"
    if (-not (Test-Path (Join-Path $InstallDir "package.json"))) {
        Write-Err "package.json not found in $InstallDir. Pass -RepoUrl <git-url> or copy the project there first."; exit 1
    }
}

Push-Location $InstallDir
Write-Step "Installing dependencies (bun install)..."
bun install
if (-not $SkipBrowser) {
    Write-Step "Installing Playwright chromium browser (for login fallback)..."
    bunx playwright-core install chromium
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "Browser install failed - HTTP login & mock mode still work" }
} else {
    Write-Warn2 "Skipping browser install (-SkipBrowser)"
}
Pop-Location

Set-Config -Dir $InstallDir
New-StartScript -Dir $InstallDir
New-DesktopShortcut -Dir $InstallDir

Write-Host ""
Write-Ok "Installation complete!"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Start the gateway:   $InstallDir\start.bat   (or: qg start)"
Write-Host "  2. Open the dashboard:  http://localhost:26405/dashboard"
Write-Host "  3. Add Qwen accounts:   dashboard -> Accounts: password, Cookies (Cookie-Editor export)"
Write-Host "     or Login link (sign in via the portal link in any browser; session is captured)"
Write-Host "  4. Wire up Claude Code: invoke the setup command from /setup/claude-code"
Write-Host ""
Write-Host "Try a mock-mode demo without accounts:" -ForegroundColor Cyan
Write-Host "  set PROVIDER=mock && bun run src\cli.ts start" -ForegroundColor DarkGray
