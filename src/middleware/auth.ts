/**
 * Auth middleware:
 *  - bearerAuth(): validates `Authorization: Bearer <API_KEY>` on /v1 routes
 *    (disabled when config API_KEY is empty). Anthropic-style clients such as
 *    Claude Code send `x-api-key: <API_KEY>` instead — both are accepted.
 *  - masterAuth(): protects management routes (dashboard API, account CRUD,
 *    config). Accepts X-Master-Key header, ?key= query param, or a session
 *    cookie set by the dashboard login page.
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { configService } from '../services/configService.js';
import { safeEqual } from '../utils/crypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth-mw');

export const DASH_COOKIE = 'qg_dash';

export function bearerAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const expected = configService.get().API_KEY;
    if (!expected) return next(); // auth disabled
    const header = c.req.header('authorization') ?? '';
    // Anthropic clients (Claude Code) send `x-api-key` instead of a Bearer token.
    const provided =
      (header.startsWith('Bearer ') ? header.slice(7).trim() : '') ||
      (c.req.header('x-api-key') ?? '').trim();
    if (!provided || !safeEqual(provided, expected)) {
      return c.json(
        { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } },
        401,
        { 'WWW-Authenticate': 'Bearer' },
      );
    }
    return next();
  };
}

/** Cookie value used by the dashboard: equals the master key hash. */
export function dashCookieValue(): string {
  const key = configService.masterKey();
  return Buffer.from(`dash:${key}`).toString('base64url');
}

export function masterAuth(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const expected = configService.masterKey();
    const header = c.req.header('x-master-key') ?? '';
    const query = c.req.query('key') ?? '';
    const cookie = c.req.header('cookie') ?? '';
    const cookieVal = cookie
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${DASH_COOKIE}=`))
      ?.slice(DASH_COOKIE.length + 1);

    const ok =
      (header && safeEqual(header, expected)) ||
      (query && safeEqual(query, expected)) ||
      (cookieVal && safeEqual(cookieVal, dashCookieValue()));

    if (!ok) {
      log.warn(
        `unauthorized management access from ${c.req.header('x-forwarded-for') ?? c.req.header('host') ?? '?'}`,
      );
      return c.json({ error: 'Unauthorized: provide X-Master-Key header or log in to the dashboard' }, 401);
    }
    return next();
  };
}
