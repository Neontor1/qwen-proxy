/**
 * Capture-link login portal ("войти через ссылку").
 *
 * Flow:
 *   1. Dashboard (master key) creates a ticket → URL `${PUBLIC_URL}/qwen/?t=<ticket>`.
 *   2. The user opens that link in ANY browser / incognito window. We proxy
 *      chat.qwen.ai through this gateway, so the login form posts *through us*.
 *   3. When the upstream signin succeeds we see the session cookies
 *      (`token`, `cna`, …) in Set-Cookie / subsequent Cookie headers and
 *      automatically create (or refresh) a cookie-based account.
 *   4. The injected banner notices the capture and tells the user to close the
 *      tab; the dashboard poll flips to "captured" and the account appears.
 *
 * The proxy rewrites absolute origins and `/api/` paths in HTML/JS/CSS/JSON
 * payloads so the SPA keeps talking to us, and re-scopes Set-Cookie to `/qwen`
 * so the browser returns the session cookies on every proxied request.
 *
 * Security: the portal is a login surface, not an open proxy — `/api/*` is only
 * proxied when the request carries a live ticket cookie, tickets expire, and
 * only chat.qwen.ai (QWEN_BASE_URL) is ever fetched server-side.
 */
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { cookieNamesFromHeader, mergeCookieHeaders } from '../utils/cookies.js';
import { shortId, uuid } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';
import { accountManager } from './accountManager.js';
import { configService } from './configService.js';

const log = createLogger('capture');

export const CAPTURE_COOKIE = 'qg_capture';
const TICKET_TTL_MS = 30 * 60 * 1000;
const SESSION_COOKIE_MARKER = 'token=';

export interface CaptureTicket {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  status: 'pending' | 'captured' | 'expired';
  cookies?: string;
  cookieNames: string[];
  email?: string;
  accountId?: string;
}

const tickets = new Map<string, CaptureTicket>();

function sweep(): void {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (now - t.createdAt > TICKET_TTL_MS && t.status !== 'captured') tickets.delete(id);
  }
}

export function createTicket(): CaptureTicket {
  sweep();
  const ticket: CaptureTicket = {
    id: shortId('cap'),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    status: 'pending',
    cookieNames: [],
  };
  tickets.set(ticket.id, ticket);
  log.info(`capture ticket created: ${ticket.id}`);
  return ticket;
}

export function getTicket(id: string): CaptureTicket | undefined {
  const t = tickets.get(id);
  if (!t) return undefined;
  if (t.status !== 'captured' && Date.now() - t.createdAt > TICKET_TTL_MS) {
    t.status = 'expired';
  }
  return t;
}

export function cancelTicket(id: string): boolean {
  return tickets.delete(id);
}

export function ticketStats(): { pending: number; captured: number } {
  sweep();
  let pending = 0;
  let captured = 0;
  for (const t of tickets.values()) {
    if (t.status === 'captured') captured++;
    else pending++;
  }
  return { pending, captured };
}

function ticketFromContext(c: Context): CaptureTicket | null {
  const fromCookie = getCookie(c, CAPTURE_COOKIE);
  if (fromCookie) {
    const t = getTicket(fromCookie);
    if (t) return t;
  }
  const fromQuery = c.req.query('t');
  if (fromQuery) return getTicket(fromQuery) ?? null;
  return null;
}

function proxyBase(c: Context): string {
  const publicUrl = configService.publicUrl();
  return `${publicUrl}/qwen`;
}

/** Rewrite upstream payloads so the SPA keeps calling the proxy. */
export function rewriteBody(text: string, base: string): string {
  return text
    .replaceAll('https://chat.qwen.ai', base)
    .replaceAll('http://chat.qwen.ai', base)
    .replaceAll('"//chat.qwen.ai', `"${base.replace(/^https?:/, '')}`)
    .replaceAll('"/api/', `"/qwen/api/`)
    .replaceAll("' /api/", `' /qwen/api/`)
    .replaceAll("'/api/", `'/qwen/api/`)
    .replaceAll('`/api/', '`/qwen/api/')
    .replaceAll('=/api/', '=/qwen/api/');
}

const BANNER = `
<script>
(() => {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;max-width:340px;padding:12px 16px;' +
    'border-radius:12px;font:13px/1.5 system-ui,sans-serif;color:#fff;background:#16a34a;' +
    'box-shadow:0 8px 30px rgba(0,0,0,.35);display:none';
  document.documentElement.appendChild(box);
  const show = (html, bg) => { box.innerHTML = html; box.style.background = bg || '#16a34a'; box.style.display = 'block'; };
  show('⏳ Login portal active — sign in to Qwen in this tab and the session will be captured automatically.', '#334155');
  const poll = setInterval(async () => {
    try {
      const r = await fetch('/qwen/__capture/status', { credentials: 'same-origin' });
      const j = await r.json();
      if (j.status === 'captured') {
        clearInterval(poll);
        show('✅ Session captured! Account <b>' + (j.email || '') + '</b> added to the gateway. You can close this tab.', '#16a34a');
      } else if (j.status === 'expired') {
        clearInterval(poll);
        show('⌛ Link expired — create a new one in the dashboard.', '#b91c1c');
      }
    } catch {}
  }, 1500);
})();
</script>
`;

function rewriteSetCookie(header: string): string {
  return header
    .split(/,\s*(?=[A-Za-z0-9_!#$%&'*+\-.^`|~]+=[^;]*;)/)
    .map((one) =>
      one
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*Secure/gi, '')
        .replace(/;\s*Path=[^;]*/gi, '; Path=/qwen'),
    )
    .join(', ');
}

function setCookiePairs(setCookieHeader: string): string {
  // "a=b; Path=/qwen, c=d; Path=/qwen" → "a=b; c=d"
  return setCookieHeader
    .split(/,\s*(?=[A-Za-z0-9_!#$%&'*+\-.^`|~]+=)/)
    .map((one) => one.split(';')[0]!.trim())
    .filter((p) => p.includes('='))
    .join('; ');
}

function captureSession(ticket: CaptureTicket, cookieHeader: string, emailHint?: string): void {
  if (!cookieHeader.includes(SESSION_COOKIE_MARKER)) return;
  ticket.cookies = cookieHeader;
  ticket.cookieNames = cookieNamesFromHeader(cookieHeader);
  ticket.status = 'captured';
  ticket.email = emailHint ?? ticket.email;

  const email = (emailHint ?? '').trim().toLowerCase();
  try {
    if (email && accountManager.findByEmail(email)) {
      const acc = accountManager.findByEmail(email)!;
      if ((acc.authKind ?? 'password') === 'cookie') {
        accountManager.updateCookies(acc.id, cookieHeader);
        ticket.accountId = acc.id;
        log.info(`capture ${ticket.id}: refreshed cookies for existing ${email}`);
        return;
      }
    }
    const finalEmail = email || `captured-${ticket.id.slice(-6)}@chat.qwen.ai`;
    const acc = accountManager.add(finalEmail, '', {
      authKind: 'cookie',
      cookies: cookieHeader,
      source: 'capture',
    });
    ticket.accountId = acc.id;
    log.info(`capture ${ticket.id}: account auto-created ${finalEmail} (${acc.id})`);
  } catch (err) {
    log.error(`capture ${ticket.id}: failed to store account: ${String(err)}`);
  }
}

async function proxyHandler(c: Context, stripPrefix: string): Promise<Response> {
  const cookieTicketId = getCookie(c, CAPTURE_COOKIE);
  const cookieValid = Boolean(cookieTicketId && getTicket(cookieTicketId));
  let ticket = ticketFromContext(c);
  // bind the ticket cookie whenever the browser did not present a live one
  const needsBind = !cookieValid;
  if (!ticket) {
    ticket = createTicket();
  }
  ticket.lastSeenAt = Date.now();

  const upstreamBase = (process.env.QWEN_BASE_URL || configService.get().QWEN_BASE_URL).replace(/\/$/, '');
  const path = c.req.path.slice(stripPrefix.length) || '/';
  const query = new URL(c.req.url).search.replace(/([?&])t=[^&]*/, '$1').replace(/[?&]$/, '');
  const url = `${upstreamBase}${path}${query}`;

  const headers = new Headers();
  for (const key of [
    'accept',
    'accept-language',
    'content-type',
    'user-agent',
    'bx-ua',
    'bx-umidtoken',
    'bx-v',
    'version',
    'source',
    'x-request-id',
  ]) {
    const v = c.req.header(key);
    if (v) headers.set(key, v);
  }
  // forward the upstream session cookies the browser holds for our proxy
  const incoming = c.req.header('cookie') ?? '';
  const upstreamCookies = incoming
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith(`${CAPTURE_COOKIE}=`))
    .join('; ');
  if (upstreamCookies) headers.set('Cookie', upstreamCookies);
  headers.set('Origin', upstreamBase);
  headers.set('Referer', `${upstreamBase}/`);
  if (!headers.has('x-request-id')) headers.set('x-request-id', uuid());

  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = await c.req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    log.warn(`capture proxy upstream error: ${String(err)}`);
    return c.json({ error: `upstream unreachable: ${String(err)}` }, 502);
  }

  // remember any session cookies we just saw (request side + response side)
  const respSetCookie = upstream.headers.get('set-cookie');
  const merged = mergeCookieHeaders(
    upstreamCookies,
    respSetCookie ? setCookiePairs(respSetCookie) : undefined,
  );
  let emailHint: string | undefined;
  const ctype = upstream.headers.get('content-type') ?? '';
  const isText = /text\/|javascript|ecmascript|json|css/.test(ctype);
  let body: BodyInit | null = null;
  const outHeaders = new Headers(upstream.headers);

  if (isText) {
    const raw = await upstream.text();
    if (path.startsWith('/api/')) {
      try {
        const j = JSON.parse(raw);
        emailHint =
          j?.data?.email ?? j?.data?.user?.email ?? j?.data?.account?.email ?? j?.email ?? undefined;
      } catch {
        /* not json */
      }
      captureSession(ticket, merged, emailHint);
    }
    let text = rewriteBody(raw, proxyBase(c));
    if (/text\/html/.test(ctype)) {
      text = text.replace('</head>', `${BANNER}</head>`);
    }
    body = text;
    outHeaders.delete('content-length');
    outHeaders.delete('content-encoding');
  } else {
    body = upstream.body;
  }

  if (respSetCookie) outHeaders.set('Set-Cookie', rewriteSetCookie(respSetCookie));
  if (needsBind) {
    outHeaders.append(
      'Set-Cookie',
      `${CAPTURE_COOKIE}=${ticket.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TICKET_TTL_MS / 1000}`,
    );
  }
  outHeaders.delete('content-security-policy');
  outHeaders.delete('x-frame-options');

  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

export const captureProxy = new Hono();

captureProxy.get('/__capture/status', (c) => {
  const ticket = ticketFromContext(c);
  if (!ticket) return c.json({ status: 'unknown' }, 404);
  return c.json({
    ticket: ticket.id,
    status: ticket.status,
    email: ticket.email ?? null,
    accountId: ticket.accountId ?? null,
    cookieNames: ticket.cookieNames,
    expiresInSeconds: Math.max(0, Math.round((ticket.createdAt + TICKET_TTL_MS - Date.now()) / 1000)),
  });
});

captureProxy.all('/', (c) => proxyHandler(c, '/qwen'));
captureProxy.all('/*', (c) => proxyHandler(c, '/qwen'));

/**
 * The SPA may call `location.origin + "/api/…"`. Proxy those too, but ONLY for
 * requests that carry a live ticket cookie — otherwise keep the gateway's own
 * (non-existent) /api routes untouched.
 */
export function rootApiCaptureProxy(): (
  c: Context,
  next: () => Promise<void>,
) => Promise<Response | undefined> {
  return async (c, next) => {
    if (!getCookie(c, CAPTURE_COOKIE)) {
      await next();
      return undefined;
    }
    return proxyHandler(c, '');
  };
}
