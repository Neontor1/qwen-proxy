/**
 * Dashboard page 1/5 — Overview: KPIs, model health, sessions & accounts,
 * live system logs and a requests/min sparkline. Data comes from
 * `GET /dashboard/api/overview` plus the shared realtime SSE stream.
 */
import type { Hono } from 'hono';
import { accountManager } from '../../services/accountManager.js';
import { configService } from '../../services/configService.js';
import { modelHealth } from '../../services/modelHealth.js';
import { monitorStore } from '../../services/monitorStore.js';
import { getProvider } from '../../services/qwen.js';
import { sessionPool } from '../../services/sessionPool.js';
import { systemLogger } from '../../services/systemLogger.js';
import { tokenCache } from '../../services/tokenCache.js';
import { layout } from './layout.js';

export function register(api: Hono): void {
  api.get('/overview', (c) => {
    const snap = monitorStore.snapshot();
    const accounts = accountManager.list();
    return c.json({
      metrics: snap,
      provider: getProvider().kind,
      publicUrl: configService.publicUrl(),
      accounts: {
        total: accounts.length,
        active: accounts.filter((a) => a.status === 'active').length,
        cooldown: accounts.filter((a) => a.status === 'cooldown').length,
        disabled: accounts.filter((a) => a.status === 'disabled' || a.status === 'error').length,
      },
      modelHealth: modelHealth.snapshot(),
      sessions: sessionPool.stats(),
      tokenCache: tokenCache.stats(),
      systemLogs: systemLogger.recent(100),
    });
  });
}

export const page = layout(
  'overview',
  `
<section class="kpis" id="kpis"></section>
<section class="grid-2">
  <div class="card"><h3>Model health</h3><div id="model-health"></div></div>
  <div class="card"><h3>Sessions & accounts</h3><div id="sessions-box"></div></div>
</section>
<section class="card"><h3>System logs <span class="muted">(live)</span></h3><div id="syslog" class="logbox"></div></section>
<section class="card"><h3>Requests / min (last 5 min)</h3><div id="sparkline"></div></section>
`,
);
