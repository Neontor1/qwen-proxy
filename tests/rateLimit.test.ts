import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QWEN_PROXY_HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-rl-'));
process.env.PROVIDER = 'mock';
// other suites pin RATE_LIMIT_ENABLED=false (env leaks across files in a single
// `bun test` process) — this suite is the one that actually tests the limiter
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_RPM = '3';
process.env.RATE_LIMIT_BURST = '3';

const { buildApp } = await import('../src/app.js');
const { configService } = await import('../src/services/configService.js');
const { accountManager } = await import('../src/services/accountManager.js');
const { resetRateLimit } = await import('../src/middleware/rateLimit.js');
// `bun test` runs every file in one process and configService is a singleton:
// force a reload so RATE_LIMIT_* from this file's env actually wins.
configService.load(true);
accountManager.load();
// provider=auto would switch to "real" once accounts exist; keep the burst
// test independent of upstream behaviour
for (const a of accountManager.list()) accountManager.remove(a.id);

const app = buildApp();

describe('rate limiter', () => {
  beforeEach(() => {
    resetRateLimit();
  });

  it('allows the burst then rejects with 429 + Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/v1/models');
      statuses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      }
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it('does not limit management routes', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    }
  });
});
