/**
 * Playwright integration — lazily loaded (playwright-core is an optional
 * runtime dependency). Used for:
 *   1. Browser-based login fallback when the HTTP login endpoint is blocked
 *      by captcha/risk control (BROWSER_LOGIN=true).
 *   2. Generating real baxia anti-bot tokens via the site SDK.
 *
 * Everything degrades gracefully: if playwright-core or the browser binaries
 * are missing, callers get a descriptive PlaywrightUnavailableError.
 */
import { createLogger } from '../utils/logger.js';
import { configService } from './configService.js';

const log = createLogger('playwright');

export class PlaywrightUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `Playwright is not available (${reason}). Install it with: npm i playwright-core && npx playwright-core install ${configService.get().BROWSER}`,
    );
    this.name = 'PlaywrightUnavailableError';
  }
}

type PW = typeof import('playwright-core');
type Browser = Awaited<ReturnType<PW['chromium']['launch']>>;
type BrowserContext = Awaited<ReturnType<Browser['newContext']>>;

let pwModule: PW | null = null;
let loadFailed: string | null = null;

async function getPw(): Promise<PW> {
  if (pwModule) return pwModule;
  if (loadFailed) throw new PlaywrightUnavailableError(loadFailed);
  try {
    pwModule = (await import('playwright-core')) as PW;
    return pwModule;
  } catch (err) {
    loadFailed = String(err);
    throw new PlaywrightUnavailableError(loadFailed);
  }
}

const BROWSER_KEYS = ['chromium', 'firefox', 'webkit'] as const;
const CHANNELS: Record<string, string | undefined> = { chrome: 'chrome', edge: 'msedge' };

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

/** Launch (once) and return the shared browser instance. */
export async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (launching) return launching;
  launching = (async () => {
    const pw = await getPw();
    const cfg = configService.get();
    const name = cfg.BROWSER;
    const engineKey = (BROWSER_KEYS as readonly string[]).includes(name)
      ? (name as (typeof BROWSER_KEYS)[number])
      : 'chromium';
    const channel = CHANNELS[name];
    const engine = pw[engineKey];
    log.info(`launching ${name} (headless)`);
    browser = await engine.launch({
      headless: true,
      channel,
      args:
        engineKey === 'chromium'
          ? ['--no-sandbox', '--disable-blink-features=AutomationControlled']
          : undefined,
    });
    return browser;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    browser = null;
    log.info('browser closed');
  }
}

export interface BrowserLoginResult {
  token: string;
  expiresAt: number;
  cookies: string;
}

/**
 * Log in to chat.qwen.ai through a real browser page. Captures the JWT either
 * from the /api/v1/auths/ response or from localStorage after redirect.
 */
export async function browserLogin(
  base: string,
  email: string,
  password: string,
  timeoutMs = 60_000,
): Promise<BrowserLoginResult> {
  const b = await getBrowser();
  const context: BrowserContext = await b.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  try {
    let capturedToken: string | null = null;

    // Prefer intercepting the auth response.
    page.on('response', async (resp) => {
      try {
        if (resp.url().includes('/api/v1/auths') && resp.request().method() === 'POST' && resp.ok()) {
          const json = (await resp.json()) as any;
          const t = json?.data?.token ?? json?.token;
          if (t) capturedToken = String(t);
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto(`${base}/auth/sign-in`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Fill whichever sign-in form variant appears.
    const emailSel = ['input[name="email"]', 'input[type="email"]', '#email'].join(', ');
    const passSel = ['input[name="password"]', 'input[type="password"]', '#password'].join(', ');
    await page.waitForSelector(emailSel, { timeout: timeoutMs });
    await page.fill(emailSel.split(', ')[0]!, email);
    const passEl = await page.waitForSelector(passSel, { timeout: 10_000 });
    await passEl.fill(password);
    const submitSel = ['button[type="submit"]', 'text=/sign in|log in|продолжить/i'].join(', ');
    await page.click(submitSel.split(', ')[0]!, { timeout: 10_000 }).catch(async () => {
      await passEl.press('Enter');
    });

    // Wait for token via response interception or localStorage.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !capturedToken) {
      await page.waitForTimeout(500);
      try {
        capturedToken = await page.evaluate(() => {
          const raw = localStorage.getItem('token');
          if (raw && raw.split('.').length === 3) return raw;
          return null;
        });
      } catch {
        /* navigation in progress */
      }
    }
    if (!capturedToken) {
      throw new Error('browser login timed out — credentials rejected or captcha required');
    }

    const cookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

    // JWT exp → epoch ms (default 1h).
    let expiresAt = Date.now() + 3600_000;
    try {
      const payload = JSON.parse(Buffer.from(capturedToken.split('.')[1]!, 'base64url').toString('utf8'));
      if (payload?.exp) expiresAt = payload.exp * 1000;
    } catch {
      /* keep default */
    }

    log.info(`browser login succeeded for ${email}`);
    return { token: capturedToken, expiresAt, cookies };
  } finally {
    await context.close().catch(() => {});
  }
}

/** True when browser login fallback is enabled AND playwright seems usable. */
export async function browserLoginAvailable(): Promise<boolean> {
  if (!configService.get().BROWSER_LOGIN) return false;
  try {
    await getPw();
    return true;
  } catch {
    return false;
  }
}
