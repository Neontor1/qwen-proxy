#!/usr/bin/env bash
# qwen-proxy-gateway: Claude Code / OpenAI client configurator (static copy).
# The live, endpoint-aware version is served by the gateway at /install/claude.sh
set -euo pipefail

MODE="${1:-install}"
ENDPOINT="${QWEN_ENDPOINT:-http://localhost:26405/v1}"
API_KEY="${QWEN_API_KEY:-}"

if [ -z "$API_KEY" ] && [ "$MODE" != "uninstall" ]; then
  read -r -p "Enter API key (leave empty for no auth): " API_KEY || true
fi

BLOCK="
# qwen-proxy-gateway (managed block)
ANTHROPIC_ROOT=$(echo "$ENDPOINT" | sed 's|/v1$||')
export ANTHROPIC_BASE_URL=\"$ANTHROPIC_ROOT\"
export ANTHROPIC_API_KEY=\"$API_KEY\"
export OPENAI_BASE_URL=\"$ENDPOINT\"
export OPENAI_API_KEY=\"$API_KEY\"
# end qwen-proxy-gateway"

remove_block() {
  local f="$1"
  [ -f "$f" ] || return 0
  awk '/# qwen-proxy-gateway \(managed block\)/{skip=1} /# end qwen-proxy-gateway/{skip=0; next} !skip' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

if [ "$MODE" = "uninstall" ]; then
  for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do remove_block "$f"; done
  echo "[SUCCESS] Environment variables removed from shell profiles."
  exit 0
fi

for f in "$HOME/.bashrc" "$HOME/.zshrc"; do
  touch "$f"
  remove_block "$f"
  printf '%s\n' "$BLOCK" >> "$f"
done

echo "[SUCCESS] Claude Code configured!"
echo "Example usage:"
echo "  claude -m qwen3-max 'Write a Python function'"
echo "Run: source ~/.bashrc (or reopen the terminal)"
