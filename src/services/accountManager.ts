/**
 * Account manager — CRUD + persistence (accounts.json, passwords encrypted
 * with the master key) + round-robin rotation with cooldown tracking,
 * error counting and automatic disabling.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { maskEmail, shortId } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';
import { paths } from '../utils/paths.js';
import { configService } from './configService.js';
import { QwenError, getProvider, registerAccountCounter } from './qwen.js';

const log = createLogger('accounts');

export type AccountStatus = 'active' | 'cooldown' | 'disabled' | 'error';

export type AccountAuthKind = 'password' | 'cookie';

export interface Account {
  id: string;
  email: string;
  /** encrypted with master key (enc:v1:...) */
  password: string;
  /** how this account authenticates upstream */
  authKind?: AccountAuthKind;
  /** encrypted `Cookie:` header for authKind=cookie accounts */
  cookies?: string | null;
  /** where the account came from (dashboard / api / capture link / config) */
  source?: string;
  /** number of cookies stored (for dashboards; values stay encrypted) */
  cookieCount?: number;
  enabled: boolean;
  cooldownUntil: number | null;
  lastUsed: number | null;
  errorCount: number;
  createdAt: number;
  lastError: string | null;
  requestsServed: number;
  tokensServed: number;
  /**
   * In-memory only: never written to accounts.json. Used for the throwaway
   * demo account seeded in mock mode so the pipeline can run with zero
   * configured accounts.
   */
  ephemeral?: boolean;
}

export interface PublicAccount extends Omit<Account, 'password'> {
  status: AccountStatus;
  emailMasked: string;
  cooldownRemainingMs: number;
}

export class NoAccountAvailableError extends Error {
  retryAfterMs: number;
  reason: 'none' | 'all-cooldown' | 'all-disabled';
  constructor(reason: 'none' | 'all-cooldown' | 'all-disabled', retryAfterMs = 0) {
    super(
      reason === 'none'
        ? 'No accounts configured. Add one via POST /accounts or the dashboard.'
        : reason === 'all-cooldown'
          ? `All accounts are cooling down. Retry in ${Math.ceil(retryAfterMs / 1000)}s.`
          : 'All accounts are disabled. Enable one via the dashboard.',
    );
    this.name = 'NoAccountAvailableError';
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

const FileSchema = z.array(
  z.object({
    id: z.string(),
    email: z.string(),
    password: z.string(),
    authKind: z.enum(['password', 'cookie']).default('password'),
    cookies: z.string().nullable().default(null),
    source: z.string().optional(),
    cookieCount: z.number().optional(),
    enabled: z.boolean().default(true),
    cooldownUntil: z.number().nullable().default(null),
    lastUsed: z.number().nullable().default(null),
    errorCount: z.number().default(0),
    createdAt: z.number().optional(),
    lastError: z.string().nullable().optional(),
    requestsServed: z.number().default(0),
    tokensServed: z.number().default(0),
  }),
);

class AccountManager {
  private accounts: Account[] = [];
  private cursor = 0;
  private loaded = false;

  constructor() {
    // Provider "auto" mode needs to know whether *real* accounts exist: the
    // in-memory mock demo account must not flip auto → real.
    registerAccountCounter(() => this.countPersistent());
  }

  /** Load accounts.json; seed from config.ACCOUNTS on first run. */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = paths.accounts();
    if (existsSync(file)) {
      try {
        const parsed = FileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
        this.accounts = parsed.map((a) => ({
          createdAt: Date.now(),
          lastError: null,
          ...a,
        })) as Account[];
        log.info(`loaded ${this.accounts.length} account(s) from ${file}`);
      } catch (err) {
        log.error(`accounts.json corrupt, starting empty: ${String(err)}`);
      }
    }
    // Seed from config (only accounts not already present by email).
    const seeds = configService.get().ACCOUNTS ?? [];
    let seeded = 0;
    for (const s of seeds) {
      if (!s.email || this.findByEmail(s.email)) continue;
      this.add(s.email, s.password, { silent: true });
      seeded++;
    }
    if (seeded) log.info(`seeded ${seeded} account(s) from config.ACCOUNTS`);
  }

  private save(): void {
    try {
      const persistent = this.accounts.filter((a) => !a.ephemeral);
      writeFileSync(paths.accounts(), JSON.stringify(persistent, null, 2), 'utf8');
    } catch (err) {
      log.error(`failed to persist accounts: ${String(err)}`);
    }
  }

  count(): number {
    this.load();
    return this.accounts.length;
  }

  /** Accounts that are persisted (excludes the in-memory mock demo account). */
  countPersistent(): number {
    this.load();
    return this.accounts.filter((a) => !a.ephemeral).length;
  }

  /** Drop in-memory demo account(s) — called as soon as a real one is added. */
  pruneEphemeral(): number {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => !a.ephemeral);
    const removed = before - this.accounts.length;
    if (removed > 0) log.info(`removed ${removed} in-memory demo account(s)`);
    return removed;
  }

  findByEmail(email: string): Account | undefined {
    this.load();
    return this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
  }

  get(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  add(
    rawEmail: string,
    password: string,
    opts: {
      silent?: boolean;
      ephemeral?: boolean;
      authKind?: AccountAuthKind;
      cookies?: string | null;
      source?: string;
    } = {},
  ): Account {
    this.load();
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Invalid email address: ${email}`);
    if (this.findByEmail(email)) throw new Error(`Account already exists: ${email}`);
    const masterKey = configService.masterKey();
    const kind = opts.authKind ?? 'password';
    if (kind === 'cookie' && !opts.cookies) throw new Error('Cookie account requires a Cookie header');
    if (kind === 'password' && !password) throw new Error('Password account requires a password');
    const account: Account = {
      id: shortId('acc'),
      email,
      password: password ? encryptSecret(password, masterKey) : '',
      authKind: kind,
      cookies: kind === 'cookie' && opts.cookies ? encryptSecret(opts.cookies, masterKey) : null,
      cookieCount:
        kind === 'cookie' && opts.cookies ? opts.cookies.split(';').filter((p) => p.includes('=')).length : 0,
      source: opts.source,
      enabled: true,
      cooldownUntil: null,
      lastUsed: null,
      errorCount: 0,
      createdAt: Date.now(),
      lastError: null,
      requestsServed: 0,
      tokensServed: 0,
      ...(opts.ephemeral ? { ephemeral: true } : {}),
    };
    this.accounts.push(account);
    // A real account makes the mock demo account redundant (and it would only
    // produce failed logins once provider "auto" switches to real).
    if (!opts.ephemeral) this.pruneEphemeral();
    this.save();
    if (!opts.silent) log.info(`account added: ${maskEmail(email)} (${account.id})`);
    return account;
  }

  remove(id: string): boolean {
    this.load();
    const idx = this.accounts.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    const [removed] = this.accounts.splice(idx, 1);
    this.save();
    log.info(`account removed: ${maskEmail(removed!.email)}`);
    return true;
  }

  setEnabled(id: string, enabled: boolean): Account | undefined {
    const acc = this.get(id);
    if (!acc) return undefined;
    acc.enabled = enabled;
    if (enabled) {
      acc.cooldownUntil = null;
      acc.errorCount = 0;
      acc.lastError = null;
    }
    this.save();
    log.info(`account ${maskEmail(acc.email)} ${enabled ? 'enabled' : 'disabled'}`);
    return acc;
  }

  /** Plaintext password for login flows (decrypted with master key). */
  decryptPassword(account: Account): string | null {
    if (!account.password) return null;
    return decryptSecret(account.password, configService.masterKey());
  }

  /** Plaintext `Cookie:` header for cookie accounts (null for password ones). */
  decryptCookies(account: Account): string | null {
    if (!account.cookies) return null;
    return decryptSecret(account.cookies, configService.masterKey());
  }

  /** Re-import fresh cookies for an existing cookie account (they do expire). */
  updateCookies(id: string, cookieHeader: string): Account | undefined {
    const acc = this.get(id);
    if (!acc) return undefined;
    if (acc.authKind !== 'cookie') return undefined;
    acc.cookies = encryptSecret(cookieHeader, configService.masterKey());
    acc.cookieCount = cookieHeader.split(';').filter((p) => p.includes('=')).length;
    acc.errorCount = 0;
    acc.lastError = null;
    acc.cooldownUntil = null;
    this.save();
    log.info(`cookies refreshed for ${maskEmail(acc.email)} (${id})`);
    return acc;
  }

  statusOf(a: Account): AccountStatus {
    const now = Date.now();
    if (!a.enabled) return a.errorCount >= configService.get().MAX_ACCOUNT_ERRORS ? 'error' : 'disabled';
    if (a.cooldownUntil && a.cooldownUntil > now) return 'cooldown';
    return 'active';
  }

  list(): PublicAccount[] {
    this.load();
    const now = Date.now();
    return this.accounts
      .map((a) => ({
        ...a,
        password: undefined as never,
        cookies: undefined as never,
        authKind: a.authKind ?? 'password',
        cookieCount: a.cookieCount ?? 0,
        source: a.source ?? 'manual',
        status: this.statusOf(a),
        emailMasked: maskEmail(a.email),
        cooldownRemainingMs: a.cooldownUntil && a.cooldownUntil > now ? a.cooldownUntil - now : 0,
      }))
      .map(({ password: _pw, ...rest }) => rest as PublicAccount);
  }

  /**
   * Round-robin pick of the next available account.
   * Throws NoAccountAvailableError when nothing can serve right now.
   */
  acquire(): Account {
    this.load();
    const now = Date.now();
    const cfg = configService.get();
    const enabled = this.accounts.filter((a) => a.enabled);
    if (this.accounts.length === 0) throw new NoAccountAvailableError('none');
    if (enabled.length === 0) throw new NoAccountAvailableError('all-disabled');

    const available = enabled.filter((a) => !a.cooldownUntil || a.cooldownUntil <= now);
    if (available.length === 0) {
      const soonest = Math.min(...enabled.map((a) => a.cooldownUntil ?? Number.MAX_SAFE_INTEGER));
      throw new NoAccountAvailableError('all-cooldown', Math.max(0, soonest - now));
    }

    // round-robin over the full list, skipping unavailable
    const n = this.accounts.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const acc = this.accounts[idx]!;
      if (available.includes(acc)) {
        this.cursor = (idx + 1) % n;
        acc.lastUsed = now;
        void cfg;
        return acc;
      }
    }
    throw new NoAccountAvailableError('all-cooldown', 0); // unreachable
  }

  reportSuccess(accountId: string, tokens = 0): void {
    const acc = this.get(accountId);
    if (!acc) return;
    acc.errorCount = 0;
    acc.lastError = null;
    acc.requestsServed++;
    acc.tokensServed += tokens;
    this.save();
  }

  reportError(accountId: string, err: QwenError | Error): void {
    const acc = this.get(accountId);
    if (!acc) return;
    const cfg = configService.get();
    acc.errorCount++;
    acc.lastError = err.message.slice(0, 300);
    const qerr = err instanceof QwenError ? err : null;

    if (qerr?.rateLimited) {
      acc.cooldownUntil = Date.now() + cfg.RATE_LIMIT_COOLDOWN_MS;
      log.warn(
        `account ${maskEmail(acc.email)} rate-limited → cooldown ${Math.round(cfg.RATE_LIMIT_COOLDOWN_MS / 1000)}s`,
      );
    }
    if (acc.errorCount >= cfg.MAX_ACCOUNT_ERRORS) {
      acc.enabled = false;
      log.error(`account ${maskEmail(acc.email)} auto-disabled after ${acc.errorCount} consecutive errors`);
    }
    this.save();
  }

  /** Clear cooldown manually (dashboard button). */
  clearCooldown(id: string): boolean {
    const acc = this.get(id);
    if (!acc) return false;
    acc.cooldownUntil = null;
    this.save();
    return true;
  }

  /** Verify credentials against the provider without consuming a slot. */
  async testLogin(id: string): Promise<{ ok: boolean; message: string }> {
    const acc = this.get(id);
    if (!acc) return { ok: false, message: 'Account not found' };
    if ((acc.authKind ?? 'password') === 'cookie') {
      const header = this.decryptCookies(acc);
      if (!header) return { ok: false, message: 'Could not decrypt cookies (master key changed?)' };
      try {
        return await getProvider().probe({ token: '', cookies: header, expiresAt: 0 });
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
    const password = this.decryptPassword(acc);
    if (!password) return { ok: false, message: 'Could not decrypt password (master key changed?)' };
    try {
      await getProvider().login(acc.email, password);
      acc.errorCount = 0;
      acc.lastError = null;
      this.save();
      return { ok: true, message: 'Login successful' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg };
    }
  }
}

export const accountManager = new AccountManager();
