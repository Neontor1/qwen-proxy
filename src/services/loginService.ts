/**
 * Login service — orchestrates obtaining valid auth tokens for an account:
 * HTTP login first (real provider) or the simulator (mock), with an optional
 * Playwright browser fallback when the site shows a captcha / risk control.
 */
import { createLogger } from '../utils/logger.js';
import type { Account } from './accountManager.js';
import { accountManager } from './accountManager.js';
import { configService } from './configService.js';
import { browserLogin, browserLoginAvailable } from './playwright.js';
import { type AuthTokens, QwenError, getProvider } from './qwen.js';
import { tokenCache } from './tokenCache.js';

const log = createLogger('login');

function isCaptchaBlock(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /captcha|non-JSON|risk control|rgv.?587|aliyun_waf|verify/i.test(msg);
}

export async function loginAccount(account: Account): Promise<AuthTokens> {
  if ((account.authKind ?? 'password') === 'cookie') {
    const header = accountManager.decryptCookies(account);
    if (!header) {
      throw new QwenError('cannot decrypt stored cookies (master key changed?)', {
        status: 401,
        authFailed: true,
        retryable: false,
      });
    }
    const tokens: AuthTokens = { token: '', cookies: header, expiresAt: Date.now() + 7 * 24 * 3600 * 1000 };
    tokenCache.set(account.id, tokens);
    log.info(`cookie session prepared for ${account.email} (provider=${getProvider().kind})`);
    return tokens;
  }
  const password = accountManager.decryptPassword(account);
  if (!password) {
    throw new QwenError('cannot decrypt stored password — MASTER_KEY changed since the account was added', {
      status: 401,
      authFailed: true,
      retryable: false,
    });
  }

  const provider = getProvider();
  try {
    const tokens = await provider.login(account.email, password);
    tokenCache.set(account.id, tokens);
    log.info(`login ok: ${account.email} (provider=${provider.kind})`);
    return tokens;
  } catch (err) {
    const authErr = err instanceof QwenError && (err.authFailed || err.status === 401);
    if (authErr || !isCaptchaBlock(err)) throw err;

    // HTTP login blocked by anti-bot → try a real browser if enabled.
    if (await browserLoginAvailable()) {
      log.warn(`HTTP login blocked for ${account.email}, falling back to browser login`);
      const cfg = configService.get();
      const result = await browserLogin(cfg.QWEN_BASE_URL, account.email, password);
      const tokens: AuthTokens = {
        token: result.token,
        expiresAt: result.expiresAt,
        cookies: result.cookies,
      };
      tokenCache.set(account.id, tokens);
      return tokens;
    }
    throw err;
  }
}
