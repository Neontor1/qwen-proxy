/**
 * Web dashboard — 5 pages (Overview / Accounts / Logs / Network / Settings).
 *
 * Per the spec each page lives in its own module exporting `page` (server-side
 * HTML shell) and `register(api)` (its JSON endpoints). This file only
 * composes them, owns the master-key login and serves the static assets; all
 * data & mutations go through the master-key protected JSON API with vanilla
 * JS in `public/app.js`, realtime updates via a single SSE stream.
 */
import { Hono } from 'hono';
import { DASH_COOKIE, dashCookieValue, masterAuth } from '../../middleware/auth.js';
import { configService } from '../../services/configService.js';
import * as accountsPage from './accounts.js';
import * as logsPage from './logs.js';
import * as networkPage from './network.js';
import * as overviewPage from './overview.js';
import * as settingsPage from './settings.js';

export const dashboard = new Hono();

/** Page modules in navigation order. */
const PAGES = [overviewPage, accountsPage, logsPage, networkPage, settingsPage] as const;

// ── login (cookie bootstrap) ───────────────────────────────────────────────
dashboard.post('/login', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
  const key = String(body?.key ?? '');
  if (!key || key !== configService.masterKey()) return c.json({ error: 'Invalid master key' }, 401);
  c.header(
    'Set-Cookie',
    `${DASH_COOKIE}=${dashCookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
  );
  return c.json({ ok: true });
});

// ── JSON API (master key required) ─────────────────────────────────────────
const api = new Hono();
api.use('*', masterAuth());
for (const page of PAGES) page.register(api);
dashboard.route('/api', api);

// ── HTML pages ─────────────────────────────────────────────────────────────
dashboard.get('/', (c) => c.html(overviewPage.page));
dashboard.get('/accounts', (c) => c.html(accountsPage.page));
dashboard.get('/logs', (c) => c.html(logsPage.page));
dashboard.get('/network', (c) => c.html(networkPage.page));
dashboard.get('/settings', (c) => c.html(settingsPage.page));

// ── static assets ──────────────────────────────────────────────────────────
dashboard.get('/public/style.css', async (c) => {
  const { readFileSync } = await import('node:fs');
  const { paths } = await import('../../utils/paths.js');
  try {
    return c.text(readFileSync(`${paths.dashboardPublic()}/style.css`, 'utf8'), 200, {
      'Content-Type': 'text/css; charset=utf-8',
    });
  } catch {
    return c.text('/* missing */', 404);
  }
});
dashboard.get('/public/app.js', async (c) => {
  const { readFileSync } = await import('node:fs');
  const { paths } = await import('../../utils/paths.js');
  try {
    return c.text(readFileSync(`${paths.dashboardPublic()}/app.js`, 'utf8'), 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
    });
  } catch {
    return c.text('// missing', 404);
  }
});
