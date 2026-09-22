/**
 * Dashboard page 2/5 — Accounts: three ways to connect a Qwen account
 *   🔑 password      — classic email+password (HTTP login, Playwright captcha fallback)
 *   🍪 cookies       — Cookie-Editor export / raw `Cookie:` header / cookies.txt,
 *                      with drag&drop, live format detection and a required-cookie checklist
 *   🔗 login link    — the gateway opens a login portal that proxies chat.qwen.ai;
 *                      sign in in any browser (incognito included) and the session is
 *                      captured automatically into a cookie account
 * plus the accounts table (kind badges, filters, test / enable / re-import / delete).
 * Handlers are shared with the public `/accounts` API in `../accounts.ts`.
 */
import type { Hono } from 'hono';
import { cancelTicket, createTicket, getTicket } from '../../services/captureProxy.js';
import { configService } from '../../services/configService.js';
import {
  addAccount,
  listAccounts,
  patchAccount,
  removeAccount,
  testAccount,
  verifyCookies,
} from '../accounts.js';
import { layout } from './layout.js';

export function register(api: Hono): void {
  // ── capture-link tickets (login through the gateway portal) ──
  api.post('/capture', (c) => {
    const ticket = createTicket();
    return c.json({
      ticket: ticket.id,
      url: `${configService.publicUrl()}/qwen?t=${ticket.id}`,
      expiresInSeconds: 30 * 60,
    });
  });
  api.get('/capture/:ticket', (c) => {
    const ticket = getTicket(c.req.param('ticket')!);
    if (!ticket) return c.json({ error: 'ticket not found' }, 404);
    return c.json({
      ticket: ticket.id,
      status: ticket.status,
      email: ticket.email ?? null,
      accountId: ticket.accountId ?? null,
      cookieNames: ticket.cookieNames,
      expiresInSeconds: Math.max(0, Math.round((ticket.createdAt + 30 * 60 * 1000 - Date.now()) / 1000)),
    });
  });
  api.delete('/capture/:ticket', (c) => {
    const ok = cancelTicket(c.req.param('ticket')!);
    return c.json({ deleted: ok });
  });

  // ── account CRUD (shared handlers) ──
  api.get('/accounts', (c) => listAccounts(c));
  api.post('/accounts', (c) => addAccount(c));
  api.post('/accounts/verify', (c) => verifyCookies(c));
  api.delete('/accounts/:id', (c) => removeAccount(c));
  api.patch('/accounts/:id', (c) => patchAccount(c));
  api.post('/accounts/:id/test', (c) => testAccount(c));
}

export const page = layout(
  'accounts',
  `
<section class="card add-card">
  <div class="row head-row">
    <h3>Add account</h3>
    <div class="segmented" role="tablist" id="add-tabs">
      <button class="seg active" data-tab="password" type="button">🔑 Password</button>
      <button class="seg" data-tab="cookies" type="button">🍪 Cookies</button>
      <button class="seg" data-tab="link" type="button">🔗 Login link</button>
    </div>
    <span class="spacer"></span>
    <button id="acc-refresh" class="btn ghost" title="Refresh list" type="button">⟳</button>
  </div>

  <div class="tab-pane active" data-pane="password">
    <form id="add-account" class="row">
      <input id="acc-email" placeholder="email@example.com" required autocomplete="off"/>
      <input id="acc-password" type="password" placeholder="password" required autocomplete="off"/>
      <button class="btn primary" type="submit">Add</button>
    </form>
    <p class="muted">
      Password is encrypted with AES-256-GCM (master key) and used for the HTTP login;
      a Playwright browser login is the captcha fallback.
    </p>
  </div>

  <div class="tab-pane" data-pane="cookies">
    <div id="cookie-drop" class="dropzone" tabindex="0" role="button" aria-label="Import cookies file">
      <div class="dz-icon">🍪</div>
      <div class="dz-title">Drop a Cookie-Editor export here</div>
      <div class="muted">
        ⤓ export from the extension (.json) — or click / Ctrl+V to paste.
        Also accepts a raw <code>Cookie:</code> header, <code>name=value</code> lines and cookies.txt
      </div>
      <input id="cookie-file" type="file" accept=".json,.txt,application/json,text/plain" hidden/>
    </div>
    <textarea
      id="cookie-input"
      class="editor short"
      spellcheck="false"
      placeholder='[{"name":"cna","value":"…"},{"name":"token","value":"…"}]   or   cna=…; token=…; ssxmod_itna=…'
    ></textarea>
    <div class="row cookie-meta">
      <span id="cookie-format" class="badge">format: —</span>
      <span id="cookie-count" class="badge">0 cookies</span>
      <span class="spacer"></span>
      <input id="cookie-label" class="grow" placeholder="label or email (optional)" autocomplete="off"/>
    </div>
    <div id="cookie-audit" class="audit"></div>
    <div id="cookie-chips" class="chips"></div>
    <div class="row">
      <button id="cookie-check" class="btn" type="button">⚡ Check session</button>
      <button id="cookie-add" class="btn primary" type="button">Add account</button>
      <span id="cookie-msg" class="muted"></span>
    </div>
    <p class="muted">
      chat.qwen.ai requires <code>cna</code>, <code>token</code>, <code>ssxmod_itna</code>,
      <code>ssxmod_itna2</code> (<code>isg</code>/<code>tfstk</code> recommended). Cookies are stored
      encrypted; re-import from the account row when they expire.
    </p>
  </div>

  <div class="tab-pane" data-pane="link">
    <div id="link-idle" class="link-box">
      <p>
        The gateway opens a <b>login portal</b> that proxies chat.qwen.ai through itself.
        Open the link in <b>any browser or incognito window</b>, sign in as usual — the session
        cookies are captured on the fly and the account appears here automatically. Nothing to paste.
      </p>
      <button id="link-create" class="btn primary" type="button">🔗 Create login link</button>
    </div>
    <div id="link-active" class="link-box hidden">
      <div class="row">
        <input id="link-url" class="grow mono" readonly/>
        <button id="link-copy" class="btn" type="button">Copy</button>
        <button id="link-open" class="btn" type="button">Open</button>
        <button id="link-cancel" class="btn ghost" type="button">Cancel</button>
      </div>
      <div class="row">
        <span id="link-status" class="pill pending">waiting for login…</span>
        <span id="link-timer" class="muted mono"></span>
        <span class="spacer"></span>
        <span id="link-cookies" class="muted"></span>
      </div>
      <div class="progress"><div id="link-progress"></div></div>
      <p class="muted">The portal tab shows its own status banner; the link expires in 30 minutes.</p>
    </div>
  </div>
</section>

<section class="card">
  <div class="row head-row">
    <h3>Accounts</h3>
    <input id="acc-search" class="grow" placeholder="filter: email / status / kind / source" autocomplete="off"/>
    <span id="acc-summary" class="badge"></span>
  </div>
  <div id="accounts-table"></div>
</section>
`,
);
