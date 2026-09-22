/**
 * Client setup helpers:
 *   GET /setup/claude-code  — ready-to-run PowerShell one-liner + curl example
 *   GET /setup/opencode     — OpenCode config snippet
 *   GET /setup/cursor       — Cursor settings snippet
 *   GET /install/claude.ps1 — generated PowerShell configurator script
 *   GET /install/claude.sh  — generated bash configurator script
 */
import type { Context } from 'hono';
import { configService } from '../services/configService.js';
import { modelRouter } from '../services/modelRouter.js';

function setupContext() {
  const cfg = configService.get();
  const base = configService.publicUrl();
  return {
    cfg,
    base,
    endpoint: `${base}/v1`,
    apiKey: cfg.API_KEY || 'sk-qwen-proxy',
    models: modelRouter.listForOpenAI().map((m) => m.id),
  };
}

export function setupClaudeCode(c: Context): Response {
  const { base, endpoint, apiKey, models } = setupContext();
  return c.json({
    powershell_command: `$script = Join-Path $env:TEMP "qwen-proxy-claude.ps1"; Invoke-WebRequest "${base}/install/claude.ps1" -OutFile $script; powershell -NoProfile -ExecutionPolicy Bypass -File $script -Mode Install`,
    bash_command: `curl -fsSL ${base}/install/claude.sh | bash -s -- install`,
    curl_example: `curl -X POST ${endpoint}/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer ${apiKey}" -d '{"model": "${models[0] ?? 'qwen3-max'}", "messages": [{"role": "user", "content": "Hello!"}]}'`,
    config: {
      endpoint,
      api_key: apiKey,
      available_models: models,
    },
    notes: [
      'Claude Code reads ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY; the installer sets them for your user.',
      'OPENAI_BASE_URL / OPENAI_API_KEY are set as well for OpenAI-compatible clients.',
    ],
  });
}

export function setupOpencode(c: Context): Response {
  const { endpoint, apiKey, models } = setupContext();
  const modelId = models[0] ?? 'qwen3-max';
  return c.json({
    file: '~/.config/opencode/opencode.json',
    config: {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        qwenproxy: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Qwen Proxy Gateway',
          options: { baseURL: endpoint, apiKey },
          models: Object.fromEntries(models.map((m) => [m, { name: m }])),
        },
      },
      model: `qwenproxy/${modelId}`,
    },
  });
}

export function setupCursor(c: Context): Response {
  const { endpoint, apiKey } = setupContext();
  return c.json({
    instructions: [
      'Cursor → Settings → Models → enable "OpenAI API Key" override',
      `Set API key: ${apiKey}`,
      `Set Base URL (OpenAI override): ${endpoint}`,
      'Add custom models from the list below',
    ],
    base_url: endpoint,
    api_key: apiKey,
    models: setupContext().models,
  });
}

/** PowerShell configurator (mirrors install/claude.ps1 from the spec). */
export function installClaudePs1(c: Context): Response {
  const { endpoint, apiKey } = setupContext();
  const script = `# qwen-proxy-gateway: Claude Code / OpenAI client configurator (generated)
param(
    [string]$Mode = "Install",
    [string]$Endpoint = "${endpoint}",
    [string]$ApiKey = "${apiKey}",
    [string]$Model = "claude-sonnet-4-5"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    $ApiKey = Read-Host "Enter API key (leave empty for no auth)"
}

if ($Mode -eq "Uninstall") {
    foreach ($v in @("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY")) {
        [Environment]::SetEnvironmentVariable($v, $null, "User")
    }
    Write-Host "[SUCCESS] Environment variables removed." -ForegroundColor Green
    exit 0
}

# Claude Code uses these env vars
$anthropicRoot = $Endpoint -replace '/v1$', ''
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", $anthropicRoot, "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $ApiKey, "User")

# For OpenAI-compatible clients
[Environment]::SetEnvironmentVariable("OPENAI_BASE_URL", $Endpoint, "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $ApiKey, "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_MODEL", $Model, "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_SMALL_FAST_MODEL", $Model, "User")

Write-Host "[SUCCESS] Claude Code configured!" -ForegroundColor Green
Write-Host "Endpoint: $Endpoint" -ForegroundColor Cyan
Write-Host "Example usage:" -ForegroundColor Cyan
Write-Host "  claude -p 'ping'                # one-shot, uses ANTHROPIC_MODEL ($Model)"
Write-Host 'Reopen the terminal for User-scope vars; the $env: doubles are for the current session.'
`;
  return c.text(script, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
}

/** Bash configurator for Linux/macOS. */
export function installClaudeSh(c: Context): Response {
  const { endpoint, apiKey } = setupContext();
  const script = `#!/usr/bin/env bash
# qwen-proxy-gateway: Claude Code / OpenAI client configurator (generated)
set -euo pipefail

MODE="\${1:-install}"
ENDPOINT="\${QWEN_ENDPOINT:-${endpoint}}"
API_KEY="\${QWEN_API_KEY:-${apiKey}}"

PROFILE_LINES="
# qwen-proxy-gateway (managed block)
ANTHROPIC_ROOT=$(echo \\"$ENDPOINT\\" | sed \'s|/v1$||\')
export ANTHROPIC_BASE_URL=\\"$ANTHROPIC_ROOT\\"
export ANTHROPIC_API_KEY=\\"$API_KEY\\"
export OPENAI_BASE_URL=\\"$ENDPOINT\\"
export OPENAI_API_KEY=\\"$API_KEY\\"
# end qwen-proxy-gateway"

remove_block() {
  local f="$1"
  [ -f "$f" ] || return 0
  awk '/# qwen-proxy-gateway \\(managed block\\)/{skip=1} /# end qwen-proxy-gateway/{skip=0; next} !skip' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

if [ "$MODE" = "uninstall" ]; then
  for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do remove_block "$f"; done
  echo "[SUCCESS] Environment variables removed from shell profiles."
  exit 0
fi

for f in "$HOME/.bashrc" "$HOME/.zshrc"; do
  touch "$f"
  remove_block "$f"
  printf '%s\\n' "$PROFILE_LINES" >> "$f"
done

echo "[SUCCESS] Claude Code configured!"
echo "Endpoint: $ENDPOINT"
echo "Example usage:"
echo "  claude -m qwen3-max 'Write a Python function'"
echo "Run: source ~/.bashrc (or reopen the terminal)"
`;
  return c.text(script, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
}

/** PowerShell fixer: writes Claude Code modelOverrides (catalog name -> wire id). */
export function fixClaudePs1(c: Context): Response {
  const wire = 'qwen3.8-max';
  const known = [
    'claude-sonnet-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-1',
    'claude-opus-4-2',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    'claude-3-5-haiku-20241022',
    'claude-3-5-haiku-latest',
  ];
  const rows = known.map((k) => `    '${k}' = '${wire}'`).join('\n');
  const script = `# qwen-proxy-gateway: make Claude Code accept the gateway model.
# Writes modelOverrides (catalog name -> wire id) into ~/.claude/settings.json,
# merging with whatever is already there. ASCII-only on purpose.
$ErrorActionPreference = 'Stop'
$f = Join-Path $env:USERPROFILE '.claude\settings.json'
New-Item -ItemType Directory -Force -Path (Split-Path $f) | Out-Null
$cfg = @{}
if (Test-Path $f) {
  (Get-Content $f -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value }
}
$cfg['modelOverrides'] = @{
${rows}
}
$cfg | ConvertTo-Json -Depth 8 | Set-Content $f -Encoding UTF8
Write-Host ('[OK] modelOverrides written: ' + $f) -ForegroundColor Green
Write-Host ('       catalog names -> ' + '${wire}' + '; now run:  claude -p "ping"') -ForegroundColor Green
`;
  return c.text(script, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
}
