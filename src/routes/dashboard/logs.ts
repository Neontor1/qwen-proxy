/**
 * Dashboard page 3/5 — Logs: request history with filters (search, status,
 * model), expandable rows and live updates. Also owns the combined realtime
 * SSE stream (`/stream`) consumed by the Logs and Overview pages.
 */
import type { Hono } from 'hono';
import { logStore } from '../../services/logStore.js';
import { systemLogger } from '../../services/systemLogger.js';
import { createSseChannel, sseHeaders } from '../../utils/streaming.js';
import { layout } from './layout.js';

export function register(api: Hono): void {
  api.get('/logs', (c) => {
    const q = c.req.query();
    return c.json(
      logStore.query({
        limit: Number(q.limit ?? 100),
        offset: Number(q.offset ?? 0),
        model: q.model,
        accountId: q.accountId,
        status:
          q.status === 'error' || q.status === 'success' ? q.status : q.status ? Number(q.status) : undefined,
        q: q.q,
      }),
    );
  });

  /** Combined realtime stream: request logs + system logs. */
  api.get('/stream', (c) => {
    const channel = createSseChannel({ heartbeatMs: 15000 });
    const offReq = logStore.subscribe((entry) => channel.send({ kind: 'request', entry }));
    const offSys = systemLogger.subscribe((rec) => channel.send({ kind: 'system', rec }));
    const timer = setInterval(() => {
      if (channel.closed) cleanup();
    }, 5000);
    function cleanup() {
      clearInterval(timer);
      offReq();
      offSys();
    }
    channel.send({ kind: 'hello', ts: Date.now() });
    return new Response(channel.readable, { headers: sseHeaders() });
  });
}

export const page = layout(
  'logs',
  `
<section class="card">
  <div class="row filters">
    <input id="f-q" placeholder="search (model / email / error)"/>
    <select id="f-status"><option value="">all statuses</option><option value="success">success</option><option value="error">errors</option></select>
    <select id="f-model"><option value="">all models</option></select>
    <button id="f-refresh" class="btn">Refresh</button>
    <label class="muted"><input type="checkbox" id="f-live" checked/> live</label>
  </div>
</section>
<section class="card"><div id="logs-table"></div></section>
`,
);
