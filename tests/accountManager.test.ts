import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QWEN_PROXY_HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-acc-'));
process.env.PROVIDER = 'mock';

const { accountManager, NoAccountAvailableError } = await import('../src/services/accountManager.js');
const { configService } = await import('../src/services/configService.js');
const { QwenError } = await import('../src/services/qwen.js');

configService.load();
accountManager.load();

describe('accountManager', () => {
  it('adds and lists accounts without exposing passwords', () => {
    // other suites share the singleton in a single-process `bun test` run
    for (const a of accountManager.list()) accountManager.remove(a.id);
    accountManager.add('one@mock.dev', 'pw');
    accountManager.add('two@mock.dev', 'pw');
    accountManager.add('three@mock.dev', 'pw');
    const list = accountManager.list();
    expect(list).toHaveLength(3);
    expect(JSON.stringify(list)).not.toContain('"pw"');
    expect(list[0]!.status).toBe('active');
  });

  it('rejects duplicates and invalid emails', () => {
    expect(() => accountManager.add('one@mock.dev', 'x')).toThrow(/already exists/);
    expect(() => accountManager.add('not-an-email', 'x')).toThrow(/Invalid email/);
  });

  it('rotates round-robin', () => {
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) seen.push(accountManager.acquire().email);
    expect(seen.slice(0, 3).sort()).toEqual(['one@mock.dev', 'three@mock.dev', 'two@mock.dev']);
    expect(seen[3]).toBe(seen[0]);
  });
  it('skips accounts in cooldown', () => {
    const one = accountManager.findByEmail('one@mock.dev')!;
    accountManager.reportError(one.id, new QwenError('429', { status: 429, rateLimited: true }));
    expect(accountManager.statusOf(one)).toBe('cooldown');
    for (let i = 0; i < 4; i++) {
      expect(accountManager.acquire().email).not.toBe('one@mock.dev');
    }
    accountManager.clearCooldown(one.id);
    expect(accountManager.statusOf(one)).toBe('active');
  });

  it('auto-disables after MAX_ACCOUNT_ERRORS', () => {
    const two = accountManager.findByEmail('two@mock.dev')!;
    const max = configService.get().MAX_ACCOUNT_ERRORS;
    for (let i = 0; i < max; i++) accountManager.reportError(two.id, new QwenError('boom', { status: 500 }));
    expect(accountManager.get(two.id)!.enabled).toBe(false);
    expect(accountManager.statusOf(accountManager.get(two.id)!)).toBe('error');
  });

  it('throws when everybody is cooling down or disabled', () => {
    for (const a of accountManager.list()) {
      const acc = accountManager.get(a.id)!;
      if (!acc.enabled) accountManager.setEnabled(acc.id, true);
      accountManager.reportError(acc.id, new QwenError('429', { status: 429, rateLimited: true }));
    }
    expect(() => accountManager.acquire()).toThrow(NoAccountAvailableError);
    try {
      accountManager.acquire();
    } catch (e) {
      const err = e as InstanceType<typeof NoAccountAvailableError>;
      expect(err.reason).toBe('all-cooldown');
      expect(err.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('persists across reloads (encrypted passwords)', async () => {
    const { readFileSync } = await import('node:fs');
    const { paths } = await import('../src/utils/paths.js');
    const raw = readFileSync(paths.accounts(), 'utf8');
    expect(raw).toContain('enc:v1:');
    expect(raw).not.toContain('"pw"');
  });
});
