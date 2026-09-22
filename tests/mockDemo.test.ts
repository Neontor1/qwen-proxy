import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-demo-'));
process.env.QWEN_PROXY_HOME = HOME;
process.env.PROVIDER = 'mock';
process.env.MOCK_DELAY_MS = '1';
// rate limiting has its own suite (tests/rateLimit.test.ts); env vars leak across
// files when `bun test` runs everything in one process, so pin it off here
process.env.RATE_LIMIT_ENABLED = 'false';

const { buildApp } = await import('../src/app.js');
const { accountManager } = await import('../src/services/accountManager.js');
const { configService } = await import('../src/services/configService.js');
const { getProvider } = await import('../src/services/qwen.js');
const { MOCK_DEMO_EMAIL, seedMockDemoAccount } = await import('../src/bootstrap.js');

configService.load(true);
accountManager.load();
const app = buildApp();

const accountsFile = path.join(HOME, 'accounts.json');
const onDisk = () => (existsSync(accountsFile) ? JSON.parse(readFileSync(accountsFile, 'utf8')) : []);

describe('mock mode without accounts', () => {
  it('seeds an in-memory demo account so the pipeline serves requests', async () => {
    // single-process `bun test` shares the account singleton with other suites
    for (const a of accountManager.list()) accountManager.remove(a.id);
    configService.update({ MOCK_DEMO_ACCOUNT: true });
    expect(accountManager.countPersistent()).toBe(0);

    const seeded = seedMockDemoAccount();
    expect(seeded).toBe(MOCK_DEMO_EMAIL);
    expect(accountManager.count()).toBe(1);
    // …but it must not look like a real account (provider stays mock)
    expect(accountManager.countPersistent()).toBe(0);
    expect(getProvider().kind).toBe('mock');

    // idempotent
    expect(seedMockDemoAccount()).toBeNull();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-max', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });

  it('never persists the demo account', () => {
    accountManager.list(); // touch → triggers a save through reportSuccess
    expect(onDisk().some((a: any) => a.email === MOCK_DEMO_EMAIL)).toBe(false);
  });

  it('disappears as soon as a real account is added', () => {
    for (const a of accountManager.list()) {
      if (a.email !== MOCK_DEMO_EMAIL) accountManager.remove(a.id);
    }
    accountManager.add('real@mock.dev', 'pw');
    const emails = accountManager.list().map((a) => a.email);
    expect(emails).toContain('real@mock.dev');
    expect(emails).not.toContain(MOCK_DEMO_EMAIL);
    expect(accountManager.count()).toBe(1);
    expect(onDisk().map((a: any) => a.email)).toEqual(['real@mock.dev']);
  });

  it('MOCK_DEMO_ACCOUNT=false disables seeding', () => {
    for (const a of accountManager.list()) accountManager.remove(a.id);
    configService.update({ MOCK_DEMO_ACCOUNT: false });
    expect(seedMockDemoAccount()).toBeNull();
    expect(accountManager.count()).toBe(0);
    configService.update({ MOCK_DEMO_ACCOUNT: true });
    expect(seedMockDemoAccount()).toBe(MOCK_DEMO_EMAIL);
  });
});
