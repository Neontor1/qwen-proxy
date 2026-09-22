#!/usr/bin/env bash
# ============================================================
#  Qwen Proxy Gateway — Linux/macOS installer (bash)
#  Usage:
#    ./install.sh                 # install
#    ./install.sh update          # update
#    ./install.sh uninstall       # remove
#  One-liner:
#    curl -sSL https://your-server.com/install.sh | bash
# ============================================================
set -euo pipefail

MODE="${1:-install}"
REPO_URL="${QG_REPO_URL:-}"
INSTALL_DIR="${QG_INSTALL_DIR:-$HOME/qwen-proxy}"
SKIP_BROWSER="${QG_SKIP_BROWSER:-0}"

info()  { printf '\033[36m[*]\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m[!]\033[0m %s\n' "$*"; }
err()   { printf '\033[31m[x]\033[0m %s\n' "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

install_bun() {
  if have bun; then ok "Bun found: $(bun --version)"; return; fi
  info "Installing Bun runtime..."
  if have curl; then
    curl -fsSL https://bun.sh/install | bash
  elif have wget; then
    wget -qO- https://bun.sh/install | bash
  else
    err "Need curl or wget to install Bun (or install Bun manually: https://bun.sh)"
  fi
  export PATH="$HOME/.bun/bin:$PATH"
  have bun || err "Bun installation failed"
  ok "Bun installed: $(bun --version)"
}

write_config() {
  local cfg="$INSTALL_DIR/config.json"
  if [ -f "$cfg" ]; then ok "config.json exists — keeping it"; return; fi
  info "Creating config.json with defaults..."
  cat > "$cfg" <<'JSON'
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
JSON
  ok "config.json created"
}

link_cli() {
  local bin_dir="/usr/local/bin"
  [ -w "$bin_dir" ] || bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  ln -sf "$INSTALL_DIR/bin/qg" "$bin_dir/qg"
  ln -sf "$INSTALL_DIR/bin/qg" "$bin_dir/qwen-proxy"
  ok "CLI linked: $bin_dir/qg (and qwen-proxy)"
}

install_systemd() {
  [ "${QG_SYSTEMD:-0}" = "1" ] || { warn "Skipping systemd service (set QG_SYSTEMD=1 to enable)"; return; }
  local unit="/etc/systemd/system/qwen-proxy.service"
  [ -w /etc/systemd/system ] || { warn "No write access to /etc/systemd/system — run with sudo for systemd"; return; }
  info "Creating systemd service..."
  cat > "$unit" <<UNIT
[Unit]
Description=Qwen Proxy Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$HOME/.bun/bin/bun run src/cli.ts start
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now qwen-proxy
  ok "systemd service installed and started"
}

case "$MODE" in
  uninstall)
    info "Uninstalling..."
    rm -f /usr/local/bin/qg /usr/local/bin/qwen-proxy "$HOME/.local/bin/qg" "$HOME/.local/bin/qwen-proxy" 2>/dev/null || true
    if have systemctl && systemctl is-enabled qwen-proxy >/dev/null 2>&1; then
      systemctl disable --now qwen-proxy || true
      rm -f /etc/systemd/system/qwen-proxy.service
      systemctl daemon-reload
    fi
    if [ -d "$INSTALL_DIR" ]; then
      backup="/tmp/qwen-proxy-backup-$(date +%Y%m%d-%H%M%S)"
      cp -r "$INSTALL_DIR" "$backup"
      warn "Data backed up to $backup"
      rm -rf "$INSTALL_DIR"
    fi
    ok "Uninstalled"
    exit 0
    ;;
  update)
    [ -d "$INSTALL_DIR" ] || err "Not installed at $INSTALL_DIR — run install first"
    info "Updating $INSTALL_DIR..."
    cd "$INSTALL_DIR"
    if [ -d .git ]; then git pull --ff-only; else warn "No git repo — refreshing dependencies only"; fi
    bun install
    [ "$SKIP_BROWSER" = "1" ] || bunx playwright-core install chromium || warn "Browser install failed (non-fatal)"
    ok "Updated"
    exit 0
    ;;
esac

echo "=============================================="
echo "   Qwen Proxy Gateway — Linux/macOS installer"
echo "=============================================="

have git || err "git is required"
have curl || have wget || err "curl or wget is required"
install_bun

info "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [ -n "$REPO_URL" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then (cd "$INSTALL_DIR" && git pull --ff-only); else git clone "$REPO_URL" "$INSTALL_DIR"; fi
else
  warn "QG_REPO_URL not set: expecting project files already in $INSTALL_DIR"
  [ -f "$INSTALL_DIR/package.json" ] || err "package.json not found in $INSTALL_DIR (set QG_REPO_URL or copy the project there)"
fi

cd "$INSTALL_DIR"
info "Installing dependencies (bun install)..."
bun install
if [ "$SKIP_BROWSER" = "1" ]; then
  warn "Skipping Playwright browser install (QG_SKIP_BROWSER=1)"
else
  info "Installing Playwright chromium (login fallback)..."
  bunx playwright-core install chromium || warn "Browser install failed — HTTP login & mock mode still work"
fi

write_config
link_cli
install_systemd

echo
ok "Installation complete!"
echo
echo "Next steps:"
echo "  1. Start:      qg start          (or: cd $INSTALL_DIR && bun start)"
echo "  2. Dashboard:  http://localhost:26405/dashboard"
echo "  3. Accounts:   dashboard → Accounts, or: qg accounts add <email> <password>"
echo "  4. Claude Code: use the command from  curl -s http://localhost:26405/setup/claude-code"
echo
echo "Mock-mode demo (no accounts needed):  PROVIDER=mock qg start"
