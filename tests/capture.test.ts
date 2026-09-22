import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-capture-'));
process.env.QWEN_PROXY_HOME = HOME;
process.env.PROVIDER = 'mock';
process.env.RATE_LIMIT_ENABLED = 'false';

// ── stub "chat.qwen.ai" using Node.js http server ────────────────────────────
let stubPort = 0;
const stubServer = createServer((req, res) => {
  const url = new URL(req.url || '', `http://localhost:${stubPort}`);
  if (url.pathname === '/api/v1/auths/signin' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'token=stub-jwt; Path=/; Domain=chat.qwen.ai, cna=stub-cna; Path=/',
    });
    res.end(JSON.stringify({ data: { token: 'stub-jwt', email: 'stub@qwen.ai' } }));
    return;
  }
  if (url.pathname === '/api/v2/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'qwen3.8-max' }] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<html><head></head><body><script>fetch("/api/v2/models");fetch("https://chat.qwen.ai/api/v2/x")</script></body></html>');
});

await new Promise<void>((resolve) => {
  stubServer.listen(0, () => {
    const address = stubServer.address();
    stubPort = typeof address === 'string' ? parseInt(address.split(':').pop() || '0') : address?.port || 0;
    resolve();
  });
});

process.env.QWEN_BASE_URL = `http://127.0.0.1:${stubPort}`;
afterAll(() => stubServer.close());

const { buildApp } = await import('../src/app.js');
const { accountManager } = await import('../src/services/accountManager.js');
const { configService } = await import('../src/services/configService.js');
const { rewriteBody } = await import('../src/services/captureProxy.js');

configService.load(true);
accountManager.load();
const app = buildApp();
const H = { 'Content-Type': 'application/json', 'X-Master-Key': configService.masterKey() };

function captureCookie(res: Response): string {
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]!);
  const found = cookies.find((c) => c.startsWith('qg_capture='));
  return found ? found.slice('qg_capture='.length) : '';
}

describe('capture-link login portal', () => {
  it('rewrites upstream payloads so the SPA keeps calling the proxy', () => {
    const out = rewriteBody(
      'fetch("/api/v2/models"); fetch("https://chat.qwen.ai/api/v2/x")',
      'http://gw/qwen',
    );
    expect(out).toContain('"/qwen/api/v2/models"');
    expect(out).toContain('http://gw/qwen/api/v2/x');
    expect(out).not.toContain('https://chat.qwen.ai');
  });

  it('creates a ticket and serves the portal with rewritten html + banner', async () => {
    const created = await app.request('/dashboard/api/capture', { method: 'POST', headers: H });
    expect(created.status).toBe(200);
    const { ticket, url } = await created.json();
    expect(url).toContain(`/qwen?t=${ticket}`);

    const res = await app.request(`/qwen?t=${ticket}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/qwen/api/v2/models');
    expect(html).toContain('__capture/status');
    const ticketCookie = captureCookie(res);
    expect(ticketCookie).toBe(ticket);

    // /api/* is proxied ONLY with a live ticket cookie
    const anon = await app.request('/api/v2/models');
    expect(anon.status).toBe(404);
    const withTicket = await app.request('/api/v2/models', { headers: { Cookie: `qg_capture=${ticket}` } });
    expect(withTicket.status).toBe(200);
    expect(await withTicket.json()).toEqual({ data: [{ id: 'qwen3.8-max' }] });
  });

  it('captures the session on login and auto-creates a cookie account', async () => {
    const created = await app.request('/dashboard/api/capture', { method: 'POST', headers: H });
    const { ticket } = await created.json();

    // portal visit binds the ticket cookie
    const portal = await app.request(`/qwen?t=${ticket}`);
    const cookie = captureCookie(portal);
    expect(cookie).toBe(ticket);

    // the SPA logs in through the proxy
    const signin = await app.request('/qwen/api/v1/auths/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qg_capture=${cookie}` },
      body: JSON.stringify({ email: 'stub@qwen.ai', password: 'x' }),
    });
    expect(signin.status).toBe(200);
    // upstream Set-Cookie is re-scoped to /qwen and stripped of Domain/Secure
    const setCookies = (signin.headers.getSetCookie?.() ?? []).join('|');
    expect(setCookies).toContain('Path=/qwen');
    expect(setCookies).not.toContain('Domain=');
    expect(setCookies).not.toContain('Secure');

    const status = await app.request('/qwen/__capture/status', {
      headers: { Cookie: `qg_capture=${cookie}` },
    });
    const st = await status.json();
    expect(st.status).toBe('captured');
    expect(st.email).toBe('stub@qwen.ai');
    expect(st.cookieNames).toContain('token');

    const accounts = await (await app.request('/accounts', { headers: H })).json();
    const captured = accounts.data.find((a: any) => a.id === st.accountId);
    expect(captured).toBeTruthy();
    expect(captured.authKind).toBe('cookie');
    expect(captured.source).toBe('capture');
    expect(captured.email).toBe('stub@qwen.ai');

    // dashboard polling endpoint agrees
    const poll = await app.request(`/dashboard/api/capture/${ticket}`, { headers: H });
    expect((await poll.json()).status).toBe('captured');
  });

  it('portal works with and without a trailing slash', async () => {
    // the wildcard route serves /qwen/ directly; other paths 301 to canonical
    const withSlash = await app.request('/qwen/');
    expect(withSlash.status).toBe(200);
    expect(await withSlash.text()).toContain('__capture/status');
    const plain = await app.request('/dashboard/accounts/');
    expect(plain.status).toBe(301);
    expect(new URL(plain.headers.get('location')!).pathname).toBe('/dashboard/accounts');
  });

  it('tickets can be cancelled and unknown tickets 404', async () => {
    const created = await app.request('/dashboard/api/capture', { method: 'POST', headers: H });
    const { ticket } = await created.json();
    expect(
      (await app.request(`/dashboard/api/capture/${ticket}`, { method: 'DELETE', headers: H })).status,
    ).toBe(200);
    expect((await app.request(`/dashboard/api/capture/${ticket}`, { headers: H })).status).toBe(404);
    expect((await app.request('/dashboard/api/capture/nope', { headers: H })).status).toBe(404);
  });
});
