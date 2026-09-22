# ============================================================
#  Qwen Proxy Gateway — Docker image
#  Default image runs the gateway WITHOUT Playwright browsers
#  (HTTP login + mock mode work out of the box).
#  Build with browsers:  docker build --build-arg WITH_BROWSER=1 -t qwen-proxy .
# ============================================================
FROM oven/bun:1 AS base

WORKDIR /app

# system deps for Playwright browsers (only used when WITH_BROWSER=1)
ARG WITH_BROWSER=0
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 \
        && rm -rf /var/lib/apt/lists/*; \
    fi

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

RUN if [ "$WITH_BROWSER" = "1" ]; then bunx playwright-core install chromium; fi

ENV QWEN_PROXY_HOME=/app/data \
    PORT=26405 \
    HOST=0.0.0.0

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 26405

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||26405)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/cli.ts", "start"]
