/**
 * GET /health | GET /ping — server status: uptime, active accounts,
 * in-flight requests, model health, session pool stats, provider mode.
 */
import type { Context } from 'hono';
import { accountManager } from '../services/accountManager.js';
import { configService } from '../services/configService.js';
import { modelHealth } from '../services/modelHealth.js';
import { monitorStore } from '../services/monitorStore.js';
import { getProvider } from '../services/qwen.js';
import { qwenModels } from '../services/qwenModels.js';
import { sessionPool } from '../services/sessionPool.js';

export function handleHealth(c: Context): Response {
  const cfg = configService.get();
  const accounts = accountManager.list();
  const snap = monitorStore.snapshot();
  const health = modelHealth.snapshot();

  const models: Record<string, string> = {};
  for (const m of qwenModels.all()) models[m.id] = health[m.id]?.state ?? 'unknown';

  return c.json({
    status: 'ok',
    uptimeSec: snap.uptimeSec,
    provider: getProvider().kind,
    port: cfg.PORT,
    accounts: {
      total: accounts.length,
      active: accounts.filter((a) => a.status === 'active').length,
      cooldown: accounts.filter((a) => a.status === 'cooldown').length,
      disabled: accounts.filter((a) => a.status === 'disabled' || a.status === 'error').length,
    },
    inflight: snap.inflight,
    models,
    sessions: sessionPool.stats(),
    requests: { total: snap.totalRequests, errors: snap.totalErrors, perMin: snap.requestsPerMin },
  });
}
