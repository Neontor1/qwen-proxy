/**
 * Session pool — keeps authenticated QwenSessions warm (one per account by
 * default, bounded by SESSION_POOL_SIZE overall, LRU eviction). Sessions wrap
 * token lifecycle: create via loginService, refresh via tokenRefresh.
 */
import { createLogger } from '../utils/logger.js';
import type { Account } from './accountManager.js';
import { configService } from './configService.js';
import { loginAccount } from './loginService.js';
import type { AuthTokens, QwenSession } from './qwen.js';
import { tokenCache } from './tokenCache.js';
import { ensureFreshTokens, forceRelogin, needsRefresh } from './tokenRefresh.js';

const log = createLogger('sessions');

class SessionPool {
  private sessions = new Map<string, QwenSession>();
  /** accounts currently mid-login, to dedupe concurrent acquires */
  private pending = new Map<string, Promise<QwenSession>>();

  /**
   * Get a session with fresh tokens for an account. Creates/refreshes/relogins
   * as needed. Concurrent calls for the same account share one promise.
   */
  async acquire(account: Account): Promise<QwenSession> {
    const existing = this.sessions.get(account.id);
    if (existing && !needsRefresh(existing.tokens) && existing.tokens.expiresAt > Date.now()) {
      existing.lastUsed = Date.now();
      return existing;
    }

    const pending = this.pending.get(account.id);
    if (pending) return pending;

    const promise = (async (): Promise<QwenSession> => {
      try {
        // Fast path: cached tokens, refresh if near expiry.
        const cached = tokenCache.get(account.id);
        if (cached && !needsRefresh(cached) && cached.expiresAt > Date.now()) {
          return this.register(account, cached);
        }
        const tokens = await ensureFreshTokens(account);
        if (tokens) return this.register(account, tokens);
        return this.register(account, await loginAccount(account));
      } catch (err) {
        // Last resort: full re-login.
        log.warn(`session acquire via cache/refresh failed for ${account.email}, re-login: ${String(err)}`);
        tokenCache.remove(account.id);
        const fresh = await forceRelogin(account).catch(async () => loginAccount(account));
        return this.register(account, fresh);
      }
    })().finally(() => this.pending.delete(account.id));

    this.pending.set(account.id, promise);
    return promise;
  }

  private register(account: Account, tokens: AuthTokens): QwenSession {
    const now = Date.now();
    const existing = this.sessions.get(account.id);
    const session: QwenSession = {
      accountId: account.id,
      email: account.email,
      tokens,
      createdAt: existing?.createdAt ?? now,
      lastUsed: now,
    };
    this.sessions.set(account.id, session);
    this.evict();
    return session;
  }

  /** Enforce SESSION_POOL_SIZE with LRU eviction (never evicts in-use... simple: evict oldest). */
  private evict(): void {
    const max = Math.max(1, configService.get().SESSION_POOL_SIZE);
    while (this.sessions.size > max) {
      let oldestKey: string | null = null;
      let oldest = Number.MAX_SAFE_INTEGER;
      for (const [key, s] of this.sessions) {
        if (s.lastUsed < oldest) {
          oldest = s.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.sessions.delete(oldestKey);
      log.debug(`evicted session ${oldestKey} (pool size ${max})`);
    }
  }

  /** Drop a session (after auth failure) so the next acquire re-logins. */
  invalidate(accountId: string): void {
    this.sessions.delete(accountId);
    tokenCache.remove(accountId);
  }

  release(session: QwenSession): void {
    session.lastUsed = Date.now();
  }

  stats(): {
    size: number;
    max: number;
    accounts: Array<{ accountId: string; email: string; createdAt: number; expiresAt: number }>;
  } {
    const max = Math.max(1, configService.get().SESSION_POOL_SIZE);
    return {
      size: this.sessions.size,
      max,
      accounts: [...this.sessions.values()].map((s) => ({
        accountId: s.accountId,
        email: s.email,
        createdAt: s.createdAt,
        expiresAt: s.tokens.expiresAt,
      })),
    };
  }

  clear(): void {
    this.sessions.clear();
  }
}

export const sessionPool = new SessionPool();
