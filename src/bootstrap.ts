/**
 * Startup orchestration shared by CLI and index.tsx: banner, server start,
 * background maintenance timers (cooldown expiry sweep, token pre-refresh),
 * graceful shutdown, optional dashboard auto-open.
 */
import { exec } from 'node:child_process';
import { buildApp } from './app.js';
import { startServer } from './server.js';
import { accountManager } from './services/accountManager.js';
import { configService } from './services/configService.js';
import { getProvider } from './services/qwen.js';
import { systemLogger } from './services/systemLogger.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('bootstrap');

export function printBanner(handle: { port: number; runtime: string }): void {
  const cfg = configService.get();
  const url = configService.publicUrl();
  const lines = [
    '',
    '  ╔══════════════════════════════════════════════════════════╗',
    '  ║            Qwen Proxy Gateway  ·  v1.0.0                 ║',
    '  ╚══════════════════════════════════════════════════════════╝',
    '',
    `  runtime      ${handle.runtime}`,
    `  api          ${url}/v1/chat/completions`,
    `  anthropic    ${url}/v1/messages`,
    `  dashboard    ${url}/dashboard`,
    `  health       ${url}/health`,
    `  setup        ${url}/setup/claude-code`,
    `  provider     ${getProvider().kind}`,
    `  accounts     ${accountManager.countPersistent()} configured${
      accountManager.count() > accountManager.countPersistent() ? ' (+1 in-memory mock demo)' : ''
    }`,
    `  auth         ${cfg.API_KEY ? 'bearer token enabled' : 'OPEN (set API_KEY to protect /v1)'}`,
    '',
  ];
  console.log(lines.join('\n'));
}

/** Periodic maintenance: session pool pruning happens on acquire; nothing
 *  heavy needed — placeholders kept minimal on purpose. */
function startMaintenanceTimers(): () => void {
  const sweep = setInterval(() => {
    // nothing persistent to sweep yet; keeps process event loop honest in tests
  }, 60_000);
  if (typeof sweep === 'object' && 'unref' in sweep) (sweep as NodeJS.Timeout).unref?.();
  return () => clearInterval(sweep);
}

/** Credentials of the throwaway account seeded in mock mode (never persisted). */
export const MOCK_DEMO_EMAIL = 'demo@mock.dev';
export const MOCK_DEMO_PASSWORD = 'mock-demo';

/**
 * The mock provider is documented as "the full pipeline without network or
 * accounts", but account rotation needs at least one account to serve a
 * request. Seed an in-memory demo account so `PROVIDER=mock` works out of the
 * box; it is never written to accounts.json and disappears as soon as a real
 * account is added. Disable with MOCK_DEMO_ACCOUNT=false.
 */
export function seedMockDemoAccount(): string | null {
  if (!configService.get().MOCK_DEMO_ACCOUNT) return null;
  if (getProvider().kind !== 'mock') return null;
  if (accountManager.countPersistent() > 0) return null;
  if (accountManager.findByEmail(MOCK_DEMO_EMAIL)) return null; // already seeded
  const acc = accountManager.add(MOCK_DEMO_EMAIL, MOCK_DEMO_PASSWORD, {
    silent: true,
    ephemeral: true,
  });
  log.info(`mock mode: seeded in-memory demo account ${MOCK_DEMO_EMAIL} (not persisted)`);
  return acc.email;
}

export async function startGateway(app?: ReturnType<typeof buildApp>): Promise<void> {
  configService.load();
  systemLogger.start();
  accountManager.load();
  seedMockDemoAccount();

  const application = app ?? buildApp();
  const handle = await startServer(application);
  printBanner(handle);

  const stopTimers = startMaintenanceTimers();

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    stopTimers();
    try {
      const { closeBrowser } = await import('./services/playwright.js');
      await closeBrowser();
    } catch {
      /* playwright not installed */
    }
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export function maybeOpenDashboard(): void {
  const url = `${configService.publicUrl()}/dashboard`;
  const cmd =
    process.platform === 'darwin'
      ? `open ${url}`
      : process.platform === 'win32'
        ? `start "" ${url}`
        : `xdg-open ${url}`;
  exec(cmd, (err) => {
    if (err) log.warn(`could not open browser automatically: ${url}`);
    else log.info(`opened dashboard: ${url}`);
  });
}
