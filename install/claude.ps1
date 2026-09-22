# qwen-proxy-gateway: Claude Code / OpenAI client configurator (static copy).
# The live, endpoint-aware version is served by the gateway at /install/claude.ps1
param(
    [string]$Mode = "Install",
    [string]$Endpoint = "http://localhost:26405/v1",
    [string]$ApiKey = "",
    [string]$Model = "claude-sonnet-4-5"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    $ApiKey = Read-Host "Enter API key (leave empty for no auth)"
}

if ($Mode -eq "Uninstall") {
    foreach ($v in @("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL")) {
        [Environment]::SetEnvironmentVariable($v, $null, "User")
    }
    Write-Host "[SUCCESS] Environment variables removed." -ForegroundColor Green
    exit 0
}

# Claude Code (Anthropic SDK) appends /v1/messages to ANTHROPIC_BASE_URL itself,
# so the base must be the ROOT; OpenAI-compatible clients keep the /v1 suffix.
$anthropicRoot = $Endpoint -replace '/v1$', ''
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", $anthropicRoot, "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $ApiKey, "User")

# For OpenAI-compatible clients
[Environment]::SetEnvironmentVariable("OPENAI_BASE_URL", $Endpoint, "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $ApiKey, "User")

# Claude Code only accepts model names from its own catalog, so we pin a known
# name (claude-sonnet-4-5); the gateway aliases it to the working qwen3.8-max.
# Override with -Model <id> any time.
[Environment]::SetEnvironmentVariable("ANTHROPIC_MODEL", $Model, "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_SMALL_FAST_MODEL", $Model, "User")

Write-Host "[SUCCESS] Claude Code configured!" -ForegroundColor Green
Write-Host "Example usage:" -ForegroundColor Cyan
Write-Host "  claude -p 'ping'                          # one-shot, uses ANTHROPIC_MODEL ($Model)"
Write-Host "  claude -p --model $Model 'ping'           # pin per run"
Write-Host "  claude                                    # interactive REPL"
Write-Host "NOTE: reopen the terminal for User-scope vars (this session already has them)."
