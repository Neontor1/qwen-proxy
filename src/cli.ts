/**
 * CLI entry: qg start | accounts | config | key | doctor | version | help
 */
import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { maybeOpenDashboard, printBanner, startGateway } from './bootstrap.js';
import { clusterWorkersRequested, runWithCluster } from './cluster.js';
import { accountManager } from './services/accountManager.js';
import { configService } from './services/configService.js';
import { getProvider } from './services/qwen.js';
import { paths } from './utils/paths.js';

const HELP = `qwen-proxy-gateway CLI

Usage: qg <command> [options]

Commands:
  start                 Start the gateway server
      --port N          Override port
      --host H          Override bind address
      --browser NAME    chromium|firefox|webkit|chrome|edge
      --mock            Force the mock provider (no network, for demos/tests)
      --workers N       Worker processes (default: config WORKERS)
      --open            Open the dashboard in a browser after start
  accounts list         List configured accounts
  accounts add <email> <password>
  accounts rm <id>
  accounts test <id>
  config get            Print effective config (secrets masked)
  config set KEY=VALUE  Update a config value (hot reload on next save)
  config path           Print config file location
  key                   Print the master key (dashboard access)
  doctor                Environment & configuration diagnostics
  version               Print version
  help                  This message
`;

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const { flags, positional } = parseFlags(argv.slice(1));

  switch (cmd) {
    case 'start': {
      if (flags.mock) process.env.PROVIDER = 'mock';
      if (flags.port) process.env.PORT = String(flags.port);
      if (flags.host) process.env.HOST = String(flags.host);
      if (flags.browser) process.env.BROWSER = String(flags.browser);
      if (flags.workers) process.env.WORKERS = String(flags.workers);
      configService.load(true);
      await runWithCluster(async () => {
        const app = buildApp();
        await startGateway(app);
        if (flags.open || configService.get().OPEN_DASHBOARD_ON_START) maybeOpenDashboard();
      });
      if (clusterWorkersRequested() > 1) {
        // primary process: keep alive
        await new Promise(() => {});
      }
      return;
    }
    case 'accounts': {
      const sub = positional[0] ?? 'list';
      configService.load();
      accountManager.load();
      if (sub === 'list') {
        const list = accountManager.list();
        if (!list.length) console.log('No accounts configured.');
        for (const a of list) {
          console.log(`${a.id}\t${a.email}\t${a.status}\terrors=${a.errorCount}\tserved=${a.requestsServed}`);
        }
        return;
      }
      if (sub === 'add') {
        const [email, password] = positional.slice(1);
        if (!email || !password) throw new Error('usage: qg accounts add <email> <password>');
        const acc = accountManager.add(email, password);
        console.log(`added ${acc.id} (${acc.email})`);
        return;
      }
      if (sub === 'rm') {
        const ok = accountManager.remove(positional[1]!);
        console.log(ok ? 'removed' : 'not found');
        return;
      }
      if (sub === 'test') {
        const res = await accountManager.testLogin(positional[1]!);
        console.log(res.ok ? `OK: ${res.message}` : `FAILED: ${res.message}`);
        process.exitCode = res.ok ? 0 : 1;
        return;
      }
      console.log('unknown accounts subcommand');
      return;
    }
    case 'config': {
      configService.load();
      const sub = positional[0] ?? 'get';
      if (sub === 'path') {
        console.log(paths.config());
        return;
      }
      if (sub === 'get') {
        const cfg = configService.get() as unknown as Record<string, unknown>;
        const masked = { ...cfg };
        if (masked.API_KEY) masked.API_KEY = '***';
        if (masked.MASTER_KEY) masked.MASTER_KEY = '***';
        console.log(JSON.stringify(masked, null, 2));
        return;
      }
      if (sub === 'set') {
        for (const pair of positional.slice(1)) {
          const idx = pair.indexOf('=');
          if (idx === -1) throw new Error(`expected KEY=VALUE, got "${pair}"`);
          const key = pair.slice(0, idx);
          const raw = pair.slice(idx + 1);
          let value: unknown = raw;
          if (raw === 'true') value = true;
          else if (raw === 'false') value = false;
          else if (/^-?\d+$/.test(raw)) value = Number(raw);
          configService.update({ [key]: value });
          console.log(`${key} = ${JSON.stringify(value)}`);
        }
        return;
      }
      console.log('unknown config subcommand');
      return;
    }
    case 'key': {
      configService.load();
      console.log(configService.masterKey());
      return;
    }
    case 'doctor': {
      configService.load();
      accountManager.load();
      const cfg = configService.get();
      const rows: Array<[string, string]> = [
        [
          'runtime',
          typeof (globalThis as any).Bun !== 'undefined'
            ? `bun ${(globalThis as any).Bun.version}`
            : `node ${process.versions.node}`,
        ],
        ['config file', `${paths.config()} (${existsSync(paths.config()) ? 'exists' : 'will be created'})`],
        ['provider', `${getProvider().kind} (config PROVIDER=${cfg.PROVIDER})`],
        ['accounts', String(accountManager.count())],
        ['port', String(cfg.PORT)],
        ['data dir', paths.config().replace(/[/\\][^/\\]+$/, '')],
        ['master key', cfg.MASTER_KEY ? 'set in config' : `auto (${paths.masterKey()})`],
      ];
      try {
        await import('playwright-core');
        rows.push(['playwright-core', 'installed']);
      } catch {
        rows.push(['playwright-core', 'NOT installed (browser login fallback unavailable)']);
      }
      for (const [k, v] of rows) console.log(`${k.padEnd(16)} ${v}`);
      return;
    }
    case 'version':
      console.log('1.0.0');
      return;
    default:
      console.log(HELP);
      return;
  }
}

main().catch((err) => {
  console.error(`qg: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
