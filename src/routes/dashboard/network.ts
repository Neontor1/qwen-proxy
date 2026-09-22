/**
 * Dashboard page 4/5 — Network: outbound calls to chat.qwen.ai captured by
 * `networkDebug` (enable NETWORK_DEBUG in Settings), with headers/body/timing
 * inspection and a clear button.
 */
import type { Hono } from 'hono';
import { networkDebug } from '../../services/networkDebug.js';
import { layout } from './layout.js';

export function register(api: Hono): void {
  api.get('/network', (c) => c.json({ entries: networkDebug.list(Number(c.req.query('limit') ?? 50)) }));
  api.get('/network/:id', (c) => {
    const entry = networkDebug.get(c.req.param('id')!);
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry);
  });
  api.post('/network/clear', (c) => {
    networkDebug.clear();
    return c.json({ ok: true });
  });
}

export const page = layout(
  'network',
  `
<section class="card">
  <div class="row">
    <span class="muted">Outbound calls to the Qwen API (enable NETWORK_DEBUG in Settings to record).</span>
    <button id="net-clear" class="btn ghost">Clear</button>
    <button id="net-refresh" class="btn">Refresh</button>
  </div>
</section>
<section class="card"><div id="network-table"></div></section>
`,
);
