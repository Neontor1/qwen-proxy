/**
 * Token cache — persists auth tokens per account (encrypted with the master
 * key) so restarts don't force a re-login. In-memory map + sessions.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { createLogger } from '../utils/logger.js';
import { paths } from '../utils/paths.js';
import { configService } from './configService.js';
import type { AuthTokens } from './qwen.js';

const log = createLogger('tokencache');

interface StoredEntry {
  token: string; // encrypted JWT
  refreshToken?: string; // encrypted
  expiresAt: number;
  cookies?: string;
  savedAt: number;
}

class TokenCache {
  private mem = new Map<string, AuthTokens>();
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = paths.sessions();
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredEntry>;
      const masterKey = configService.masterKey();
      for (const [accountId, entry] of Object.entries(raw)) {
        const token = decryptSecret(entry.token, masterKey);
        if (!token) continue;
        this.mem.set(accountId, {
          token,
          refreshToken: entry.refreshToken
            ? (decryptSecret(entry.refreshToken, masterKey) ?? undefined)
            : undefined,
          expiresAt: entry.expiresAt,
          cookies: entry.cookies,
        });
      }
      log.info(`restored ${this.mem.size} cached token(s)`);
    } catch (err) {
      log.warn(`sessions.json unreadable, starting fresh: ${String(err)}`);
    }
  }

  private persist(): void {
    try {
      const masterKey = configService.masterKey();
      const out: Record<string, StoredEntry> = {};
      for (const [accountId, tokens] of this.mem) {
        out[accountId] = {
          token: encryptSecret(tokens.token, masterKey),
          refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken, masterKey) : undefined,
          expiresAt: tokens.expiresAt,
          cookies: tokens.cookies,
          savedAt: Date.now(),
        };
      }
      writeFileSync(paths.sessions(), JSON.stringify(out, null, 2), { mode: 0o600 });
    } catch (err) {
      log.error(`failed to persist token cache: ${String(err)}`);
    }
  }

  get(accountId: string): AuthTokens | undefined {
    this.ensureLoaded();
    const t = this.mem.get(accountId);
    if (!t) return undefined;
    if (t.expiresAt && t.expiresAt < Date.now()) {
      // Expired — keep it around only if a refresh token exists.
      if (!t.refreshToken) this.mem.delete(accountId);
      else return t;
    }
    return t;
  }

  set(accountId: string, tokens: AuthTokens): void {
    this.ensureLoaded();
    this.mem.set(accountId, tokens);
    this.persist();
  }

  remove(accountId: string): void {
    this.ensureLoaded();
    if (this.mem.delete(accountId)) this.persist();
  }

  clear(): void {
    this.mem.clear();
    this.persist();
  }

  stats(): { cached: number } {
    this.ensureLoaded();
    return { cached: this.mem.size };
  }
}

export const tokenCache = new TokenCache();
