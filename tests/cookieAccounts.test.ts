import { describe, expect, it } from 'vitest/globals';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-cookie-acc-'));
process.env.QWEN_PROXY_HOME = HOME;
process.env.PROVIDER = 'mock';
process.env.MOCK_DELAY_MS = '1';
process.env.RATE_LIMIT_ENABLED = 'false';

const { buildApp } = await import('../src/app.js');
const { accountManager } = await import('../src/services/accountManager.js');
const { configService } = await import('../src/services/configService.js');

configService.load(true);
accountManager.load();
const app = buildApp();
const masterKey = configService.masterKey();
const H = { 'Content-Type': 'application/json', 'X-Master-Key': masterKey };

const COOKIES = 'cna=cna-1; token=jwt-1; ssxmod_itna=s1; ssxmod_itna2=s2; isg=i1';

const post = (url: string, body: unknown, headers: Record<string, string> = H) =>
  app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });

describe('cookie-based accounts', () => {
  it('POST /accounts with cookies creates a cookie account', async () => {
    const res = await post('/accounts', { cookies: COOKIES, label: 'Work laptop' });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.authKind).toBe('cookie');
    expect(json.cookieCount).toBe(5);
    expect(json.audit.ok).toBe(true);
    expect(json.email).toContain('work-laptop');
  });

  it('accepts a Cookie-Editor JSON export too', async () => {
    const exportJson = JSON.stringify([
      { name: 'cna', value: 'a', domain: '.qwen.ai' },
      { name: 'token', value: 'b', domain: 'chat.qwen.ai' },
      { name: 'ssxmod_itna', value: 'c', domain: '.qwen.ai' },
      { name: 'ssxmod_itna2', value: 'd', domain: '.qwen.ai' },
    ]);
    const res = await post('/accounts', { cookies: exportJson, email: 'editor@mock.dev' });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.email).toBe('editor@mock.dev');
    expect(json.cookieCount).toBe(4);
  });

  it('never stores cookies in plaintext', () => {
    const file = path.join(HOME, 'accounts.json');
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('jwt-1');
    expect(raw).not.toContain('cna-1');
    expect(raw).toContain('enc:v1:');
  });

  it('list() exposes kind/cookieCount but no secrets', async () => {
    const res = await app.request('/accounts', { headers: H });
    const json = await res.json();
    const acc = json.data.find((a: any) => a.email === 'editor@mock.dev');
    expect(acc.authKind).toBe('cookie');
    expect(acc.cookieCount).toBe(4);
    expect(acc.cookies).toBeUndefined();
    expect(acc.password).toBeUndefined();
  });

  it('POST /accounts/verify probes without saving', async () => {
    const before = accountManager.count();
    const res = await post('/accounts/verify', { cookies: COOKIES });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true); // mock provider accepts any session
    expect(json.format).toBe('header');
    expect(json.cookieNames).toContain('token');
    expect(accountManager.count()).toBe(before);
  });

  it('cookie accounts participate in the chat pipeline (mock provider)', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-max', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const served = accountManager.list().some((a) => (a.requestsServed ?? 0) > 0);
    expect(served).toBe(true);
  });

  it('PATCH re-imports fresh cookies', async () => {
    const list = await (await app.request('/accounts', { headers: H })).json();
    const acc = list.data.find((a: any) => a.email === 'editor@mock.dev');
    const res = await app.request(`/accounts/${acc.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ cookies: 'cna=new; token=new-jwt; ssxmod_itna=x; ssxmod_itna2=y' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cookieCount).toBe(4);
    const raw = readFileSync(path.join(HOME, 'accounts.json'), 'utf8');
    expect(raw).not.toContain('new-jwt');
  });

  it('test endpoint probes the cookie session', async () => {
    const list = await (await app.request('/accounts', { headers: H })).json();
    const acc = list.data.find((a: any) => a.email === 'editor@mock.dev');
    const res = await app.request(`/accounts/${acc.id}/test`, { method: 'POST', headers: H });
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it('rejects payloads without usable cookies and without credentials', async () => {
    expect((await post('/accounts', { cookies: '   ' })).status).toBe(400);
    expect((await post('/accounts', { email: 'x@y.z' })).status).toBe(400);
  });
});
