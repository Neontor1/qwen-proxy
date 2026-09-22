/**
 * Runtime adapter: Bun.serve when available (priority per spec), otherwise
 * @hono/node-server on Node.js ≥ 20. SSE-friendly timeouts in both cases.
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { configService } from './services/configService.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('server');

export interface ServerHandle {
  port: number;
  hostname: string;
  stop: () => Promise<void> | void;
  runtime: 'bun' | 'node';
}

export function isBun(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
}

export interface FetchApp {
  fetch(req: Request, env?: unknown, ctx?: unknown): Promise<Response> | Response;
}

/** Can we actually bind this port right now? (catches busy AND OS-excluded ports) */
function portIsBindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host }, () => {
      probe.close(() => resolve(true));
    });
  });
}

const FALLBACK_SCAN = 50;

function portGuidance(hostname: string, port: number): string {
  return (
    `cannot bind ${hostname}:${port}. Another process — or a Windows reserved/excluded ` +
    'port range (Hyper-V) — holds it. Pick ANY port yourself: ' +
    '`qg start --port 31337`, `$env:PORT=31337` (PowerShell) or `"PORT": "31337"` in config.json. ' +
    'With PORT_AUTO_FALLBACK=true (default) the gateway takes the next free port on its own. ' +
    'Windows excluded ranges: `netsh interface ipv4 show excludedportrange protocol=tcp`.'
  );
}

export async function startServer(app: FetchApp): Promise<ServerHandle> {
  const cfg = configService.get();
  const requested = Number(cfg.PORT) || 26405;
  const hostname = cfg.HOST || '0.0.0.0';
  let port = requested;

  if (!(await portIsBindable(requested, hostname))) {
    if (!cfg.PORT_AUTO_FALLBACK) throw new Error(portGuidance(hostname, requested));
    let found = 0;
    for (let i = 1; i <= FALLBACK_SCAN; i++) {
      if (await portIsBindable(requested + i, hostname)) {
        found = requested + i;
        break;
      }
    }
    if (!found) throw new Error(portGuidance(hostname, requested));
    log.warn(
      `port ${requested} is busy or excluded on this system — using ${found} instead ` +
        '(PORT_AUTO_FALLBACK=false disables this; set PORT to any port you like)',
    );
    port = found;
    configService.adoptPort(port);
  }

  if (isBun()) {
    const Bun = (globalThis as Record<string, any>).Bun;
    let server: any;
    try {
      server = Bun.serve({
        port,
        hostname,
        // SSE streams must never hit the idle timeout; heartbeats keep them alive.
        idleTimeout: 0,
        fetch: app.fetch as any,
        error(err: unknown) {
          log.error(`server error: ${String(err)}`);
          return new Response(JSON.stringify({ error: { message: String(err), type: 'api_error' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });
    } catch (err) {
      throw new Error(`${portGuidance(hostname, port)} (${String(err)})`);
    }
    if (server.port !== port) configService.adoptPort(server.port);
    log.info(`listening on http://${hostname}:${server.port} (bun ${Bun.version})`);
    return {
      port: server.port,
      hostname,
      runtime: 'bun',
      stop: () => server.stop(),
    };
  }

  const { serve } = await import('@hono/node-server');
  const server = serve({ port, hostname, fetch: app.fetch as any }, (info) => {
    log.info(`listening on http://${hostname}:${info.port} (node ${process.versions.node})`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err) => reject(new Error(`${portGuidance(hostname, port)} (${String(err)})`)));
  });
  const actual = (server.address() as AddressInfo | null)?.port;
  if (actual && actual !== port) configService.adoptPort(actual);
  // Long-lived SSE connections
  (server as any).requestTimeout = 0;
  (server as any).keepAliveTimeout = 65_000;
  return {
    port: actual || port,
    hostname,
    runtime: 'node',
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
