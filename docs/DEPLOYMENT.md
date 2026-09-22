# Production Deployment — Qwen Proxy Gateway

## Checklist

1. **Set secrets**: `API_KEY` (protects `/v1`), `MASTER_KEY` (protects management).
2. **Put a TLS reverse proxy** in front (nginx/caddy) — the gateway speaks plain HTTP.
3. **Restrict bind**: keep `HOST=0.0.0.0` only behind the proxy/firewall; otherwise `HOST=127.0.0.1`.
4. **Persist data**: `config.json`, `accounts.json`, `sessions.json`, `master.key`, `logs/`
   live in the data dir (project root or `QWEN_PROXY_HOME`). Back it up (contains encrypted
   credentials — the master key is the decryption root!).
5. **Enable request logs** if you need audit: `SAVE_REQUEST_LOGS=true`.

## systemd (Linux)

```ini
# /etc/systemd/system/qwen-proxy.service
[Unit]
Description=Qwen Proxy Gateway
After=network.target

[Service]
Type=simple
User=qwenproxy
WorkingDirectory=/opt/qwen-proxy
ExecStart=/home/qwenproxy/.bun/bin/bun run src/cli.ts start
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=QWEN_PROXY_HOME=/opt/qwen-proxy
# Environment=MASTER_KEY=change-me
# Environment=API_KEY=sk-change-me

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now qwen-proxy
journalctl -fu qwen-proxy
```

(The installer creates this unit for you when `QG_SYSTEMD=1 ./install.sh`.)

## nginx (TLS termination + SSE-friendly buffering)

```nginx
server {
    listen 443 ssl http2;
    server_name qwen.example.com;
    ssl_certificate     /etc/letsencrypt/live/qwen.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qwen.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:26405;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        # SSE must not be buffered:
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }
}
```

## Caddy (automatic HTTPS)

```caddyfile
qwen.example.com {
    reverse_proxy 127.0.0.1:26405 {
        flush_interval -1   # disable buffering for SSE
    }
}
```

## Docker

```bash
docker compose up -d --build          # data in volume qwen-data
docker compose logs -f
```

Image notes:
- Default build has **no Playwright browsers** (HTTP login + mock mode work).
- `--build-arg WITH_BROWSER=1` bakes chromium for browser-login fallback
  (captcha/risk-control rescue). Larger image (~+400 MB).

## Multi-core

`WORKERS=N` (or `-1` = all cores) forks cluster workers via `node:cluster`.
State (accounts, logs, rate-limit buckets) is per-process; put a sticky-less
round-robin in front only if you accept per-worker metrics. For most deployments
a single process saturates the upstream long before the CPU.

## Upstream resilience

- Accounts hitting 429/risk-control cool down for `RATE_LIMIT_COOLDOWN_MS`.
- A failed attempt transparently fails over to the next account
  (`RETRY_MAX_ATTEMPTS`).
- Models marked `down` by `modelHealth` are deprioritized by the router.
- If chat.qwen.ai changes endpoints, override without code changes:
  `QWEN_BASE_URL`, `QWEN_AUTH_PATH`, `QWEN_REFRESH_PATH`, `QWEN_MODELS_PATH`,
  `QWEN_CREATE_CHAT_PATH`, `QWEN_CHAT_SEND_PATH` (`{chat_id}` placeholder).

## Monitoring hooks

- `GET /health` — liveness + account/model/session summary (use as container probe).
- Dashboard Overview — KPIs, sparkline, model health, live system log.
- `logs/requests.jsonl` (`SAVE_REQUEST_LOGS=true`) — machine-readable audit trail.
