import { describe, expect, it } from 'vitest/globals';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QWEN_PROXY_HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-dash-'));
process.env.PROVIDER = 'mock';
// rate limiting has its own suite (tests/rateLimit.test.ts); env vars leak across
// files when `bun test` runs everything in one process, so pin it off here
process.env.RATE_LIMIT_ENABLED = 'false';

const { buildApp } = await import('../src/app.js');
const { accountManager } = await import('../src/services/accountManager.js');
const { configService } = await import('../src/services/configService.js');

configService.load(true);
accountManager.load();
const app = buildApp();
const masterKey = configService.masterKey();

const PAGES = [
  ['/', 'overview'],
  ['/accounts', 'accounts'],
  ['/logs', 'logs'],
  ['/network', 'network'],
  ['/settings', 'settings'],
] as const;

describe('dashboard (5 pages, split per spec)', () => {
  for (const [route, id] of PAGES) {
    it(`renders ${route} as data-page="${id}"`, async () => {
      const res = await app.request(`/dashboard${route === '/' ? '' : route}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<!doctype html>');
      expect(html).toContain(`data-page="${id}"`);
      expect(html).toContain('/dashboard/public/app.js');
      // navigation lists all five pages, current one marked active
      for (const [, navId] of PAGES) {
        expect(html).toContain(`>${navId[0].toUpperCase()}${navId.slice(1)}</a>`);
      }
      expect(html).toContain('class="nav active"');
    });
  }

  it('trailing slashes redirect to the canonical URL', async () => {
    for (const [route, canonical] of [
      ['/dashboard/', '/dashboard'],
      ['/dashboard/accounts/', '/dashboard/accounts'],
      ['/v1/models/', '/v1/models'],
    ] as const) {
      const res = await app.request(route);
      expect(res.status).toBe(301);
      expect(new URL(res.headers.get('location')!).pathname).toBe(canonical);
      const follow = await app.request(canonical);
      expect(follow.status).toBe(200);
    }
  });

  it('settings page hosts Monaco with a plain-textarea fallback', async () => {
    const html = await (await app.request('/dashboard/settings')).text();
    expect(html).toContain('id="cfg-monaco"');
    expect(html).toContain('id="cfg-editor"');
    expect(html).toContain('id="cfg-editor-mode"');
    expect(html).toContain('id="cfg-format"');
  });

  it('app.js bootstraps Monaco from a CDN and degrades offline', async () => {
    const js = await (await app.request('/dashboard/public/app.js')).text();
    expect(js).toContain('monaco-editor@');
    expect(js).toContain('editor: monaco');
    expect(js).toContain('editor: plain (Monaco offline)');
    expect(js).toContain('initConfigEditor');
  });

  it('serves the stylesheet with the Monaco host rule', async () => {
    const res = await app.request('/dashboard/public/style.css');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('.monaco-host');
  });

  it('page-owned JSON API endpoints work with the master key', async () => {
    const headers = { 'X-Master-Key': masterKey };
    for (const p of [
      '/overview',
      '/accounts',
      '/logs?limit=5',
      '/network',
      '/config',
      '/config/raw',
      '/sessions',
    ]) {
      const res = await app.request(`/dashboard/api${p}`, { headers });
      expect(res.status).toBe(200);
    }
    const denied = await app.request('/dashboard/api/overview');
    expect(denied.status).toBe(401);
  });

  it('config round-trip: PUT /config hot-reloads and survives validation errors', async () => {
    const headers = { 'X-Master-Key': masterKey, 'Content-Type': 'application/json' };
    const ok = await app.request('/dashboard/api/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ raw: JSON.stringify({ PORT: '26405', RATE_LIMIT_RPM: 42 }, null, 2) }),
    });
    expect(ok.status).toBe(200);
    expect(configService.get().RATE_LIMIT_RPM).toBe(42);

    const bad = await app.request('/dashboard/api/config', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ raw: '{ not json' }),
    });
    expect(bad.status).toBe(422); // unprocessable: invalid JSON text
  });
});
