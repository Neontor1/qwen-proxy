/**
 * Account management API (master-key protected):
 *   GET    /accounts            — list accounts (no secrets)
 *   POST   /accounts            — add account {email, password} or {cookies[, email|label]}
 *   POST   /accounts/verify     — dry-run: parse + audit + probe cookies, save nothing
 *   DELETE /accounts/:id        — remove
 *   PATCH  /accounts/:id        — {enabled?, clearCooldown?, cookies?}
 *   POST   /accounts/:id/test   — verify credentials / session against the provider
 */
import type { Context } from 'hono';
import { accountManager } from '../services/accountManager.js';
import { getProvider } from '../services/qwen.js';
import { sessionPool } from '../services/sessionPool.js';
import {
  auditCookies,
  filterForQwen,
  maskCookieList,
  parseCookies,
  toCookieHeader,
} from '../utils/cookies.js';
import { shortId } from '../utils/ids.js';
import { addAccountSchema, verifyCookiesSchema } from './schemas.js';

/** Parse + normalise a cookie payload; returns header, audit info and warnings. */
function normalizeCookies(raw: string) {
  const parsed = parseCookies(raw);
  const { kept, dropped } = filterForQwen(parsed.cookies);
  const header = toCookieHeader(kept);
  const audit = auditCookies(kept);
  return { parsed, kept, dropped, header, audit };
}

function synthesizeEmail(label?: string): string {
  const slug = (label ?? 'cookie')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 24);
  return `${slug || 'cookie'}-${shortId('').replace('_', '')}@cookie.local`;
}

export function listAccounts(c: Context): Response {
  return c.json({ object: 'list', data: accountManager.list() });
}

export async function addAccount(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }
  const parsed = addAccountSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
      400,
    );
  }
  const { email, password, cookies, label } = parsed.data;

  // ── cookie account ──
  if (cookies) {
    const { kept, dropped, header, audit } = normalizeCookies(cookies);
    if (!header) return c.json({ error: 'No usable cookies found in the payload' }, 400);
    const finalEmail = email ?? synthesizeEmail(label);
    try {
      const account = accountManager.add(finalEmail, '', {
        authKind: 'cookie',
        cookies: header,
        source: 'api',
      });
      return c.json(
        {
          id: account.id,
          email: account.email,
          status: 'active',
          authKind: 'cookie',
          cookieCount: account.cookieCount ?? kept.length,
          audit,
          droppedCookies: dropped.map((d) => d.name),
          warnings: audit.missing.length ? [`missing required cookies: ${audit.missing.join(', ')}`] : [],
        },
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }

  // ── password account ──
  if (!email || !password) {
    return c.json({ error: 'Provide {email, password} or {cookies} (Cookie-Editor export)' }, 400);
  }
  try {
    const account = accountManager.add(email, password);
    return c.json({ id: account.id, email: account.email, status: 'active', authKind: 'password' }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
}

/** Dry-run check of a cookie payload: parse → audit → live probe. Saves nothing. */
export async function verifyCookies(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }
  const parsed = verifyCookiesSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'cookies: required' }, 400);

  const { parsed: parseResult, kept, dropped, header, audit } = normalizeCookies(parsed.data.cookies);
  if (!header) return c.json({ error: 'No usable cookies found in the payload' }, 400);

  const probe = await getProvider()
    .probe({ token: '', cookies: header, expiresAt: 0 })
    .catch((err) => ({ ok: false, message: String(err) }));

  return c.json({
    ok: probe.ok,
    message: probe.message,
    format: parseResult.format,
    cookieCount: kept.length,
    cookieNames: kept.map((k) => k.name),
    masked: maskCookieList(kept),
    droppedCookies: dropped.map((d) => d.name),
    audit,
    warnings: [
      ...parseResult.warnings,
      ...(audit.missing.length ? [`missing required cookies: ${audit.missing.join(', ')}`] : []),
    ],
  });
}

export function removeAccount(c: Context): Response {
  const id = c.req.param('id')!;
  sessionPool.invalidate(id);
  const removed = accountManager.remove(id);
  if (!removed) return c.json({ error: 'Account not found' }, 404);
  return c.json({ deleted: true, id });
}

export async function patchAccount(c: Context): Promise<Response> {
  const id = c.req.param('id')!;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }
  if (typeof body?.cookies === 'string' && body.cookies.trim()) {
    const { header, audit } = normalizeCookies(body.cookies);
    if (!header) return c.json({ error: 'No usable cookies found in the payload' }, 400);
    const acc = accountManager.updateCookies(id, header);
    if (!acc) return c.json({ error: 'Account not found or not a cookie account' }, 404);
    sessionPool.invalidate(id);
    return c.json({
      id: acc.id,
      email: acc.email,
      enabled: acc.enabled,
      status: accountManager.statusOf(acc),
      authKind: acc.authKind ?? 'password',
      cookieCount: acc.cookieCount ?? 0,
      errorCount: acc.errorCount,
      audit,
    });
  }
  if (typeof body?.enabled === 'boolean') {
    const acc = accountManager.setEnabled(id, body.enabled);
    if (!acc) return c.json({ error: 'Account not found' }, 404);
    if (!body.enabled) sessionPool.invalidate(id);
  }
  if (body?.clearCooldown) accountManager.clearCooldown(id);
  const acc = accountManager.list().find((a) => a.id === id);
  if (!acc) return c.json({ error: 'Account not found' }, 404);
  return c.json(acc);
}

export async function testAccount(c: Context): Promise<Response> {
  const id = c.req.param('id')!;
  const result = await accountManager.testLogin(id);
  return c.json(result, result.ok ? 200 : 401);
}
