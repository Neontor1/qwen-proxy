/**
 * Auth orchestration — the single entry point the chat pipeline uses:
 *   getSession(account)      → valid, warm QwenSession (login/refresh as needed)
 *   handleAuthFailure(...)   → invalidate + one forced re-login attempt
 */
import { createLogger } from '../utils/logger.js';
import type { Account } from './accountManager.js';
import { QwenError, type QwenSession } from './qwen.js';
import { sessionPool } from './sessionPool.js';
import { forceRelogin } from './tokenRefresh.js';

const log = createLogger('auth');

export async function getSession(account: Account): Promise<QwenSession> {
  return sessionPool.acquire(account);
}

/**
 * React to a 401/403 from upstream: drop the session and try a forced
 * re-login exactly once. Returns the new session or throws.
 */
export async function recoverFromAuthFailure(account: Account, cause: unknown): Promise<QwenSession> {
  log.warn(`auth failure for ${account.email}: ${String(cause)} — forcing re-login`);
  sessionPool.invalidate(account.id);
  try {
    const tokens = await forceRelogin(account);
    return sessionPool.acquire({ ...account } as Account).then((s) => {
      // acquire() will pick the fresh tokens from the cache
      void tokens;
      return s;
    });
  } catch (err) {
    throw new QwenError(`re-login failed for ${account.email}: ${String(err)}`, {
      status: 401,
      authFailed: true,
      retryable: false,
    });
  }
}

export function releaseSession(session: QwenSession): void {
  sessionPool.release(session);
}

export { sessionPool };
