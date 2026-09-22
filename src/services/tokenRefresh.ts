/**
 * Token refresh — proactively refreshes tokens that expire within a lead
 * window, reactively on auth failures. Falls back to a full re-login when
 * refresh is impossible.
 */
import { createLogger } from '../utils/logger.js';
import type { Account } from './accountManager.js';
import { accountManager } from './accountManager.js';
import { type AuthTokens, QwenError, getProvider } from './qwen.js';
import { tokenCache } from './tokenCache.js';

const log = createLogger('tokenrefresh');

/** Refresh this long before expiry. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/** In-flight dedupe: one refresh per account at a time. */
const inflight = new Map<string, Promise<AuthTokens>>();

export function needsRefresh(tokens: AuthTokens): boolean {
  if (!tokens.expiresAt) return false;
  return tokens.expiresAt - Date.now() < REFRESH_LEAD_MS;
}

/** How long a cookie session is assumed valid before we re-check upstream. */
const COOKIE_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/** Cookie accounts authenticate with a captured `Cookie:` header, no login call. */
function cookieTokens(account: Account): AuthTokens {
  const header = accountManager.decryptCookies(account);
  if (!header) {
    throw new QwenError('cannot decrypt stored cookies (master key changed?)', {
      status: 401,
      authFailed: true,
      retryable: false,
    });
  }
  return { token: '', cookies: header, expiresAt: Date.now() + COOKIE_SESSION_TTL_MS };
}

async function doLogin(account: Account): Promise<AuthTokens> {
  if ((account.authKind ?? 'password') === 'cookie') {
    const tokens = cookieTokens(account);
    tokenCache.set(account.id, tokens);
    log.info(`cookie session prepared for ${account.email}`);
    return tokens;
  }
  const password = accountManager.decryptPassword(account);
  if (!password) {
    throw new QwenError('cannot decrypt account password (master key changed?)', {
      status: 401,
      authFailed: true,
      retryable: false,
    });
  }
  const tokens = await getProvider().login(account.email, password);
  tokenCache.set(account.id, tokens);
  log.info(`fresh login for ${account.email}`);
  return tokens;
}

async function doRefresh(account: Account, tokens: AuthTokens): Promise<AuthTokens> {
  // Cookies cannot be refreshed server-side; keep using them until upstream 401s.
  if ((account.authKind ?? 'password') === 'cookie') return tokens;
  try {
    const refreshed = await getProvider().refresh(tokens, account.email);
    tokenCache.set(account.id, refreshed);
    return refreshed;
  } catch (err) {
    log.warn(`refresh failed for ${account.email}, re-logging in: ${String(err)}`);
    return doLogin(account);
  }
}

/**
 * Get valid tokens for an account: cached → refresh if near expiry → login.
 * Concurrent callers share one in-flight promise.
 */
export function ensureFreshTokens(account: Account): Promise<AuthTokens> {
  const existing = inflight.get(account.id);
  if (existing) return existing;

  const promise = (async (): Promise<AuthTokens> => {
    const cached = tokenCache.get(account.id);
    if (cached && !needsRefresh(cached) && cached.expiresAt > Date.now()) return cached;
    if (cached) return doRefresh(account, cached);
    return doLogin(account);
  })().finally(() => inflight.delete(account.id));

  inflight.set(account.id, promise);
  return promise;
}

/** Force re-login (after 401s) and update the cache. */
export function forceRelogin(account: Account): Promise<AuthTokens> {
  tokenCache.remove(account.id);
  const promise = doLogin(account).finally(() => inflight.delete(account.id));
  inflight.set(account.id, promise);
  return promise;
}
