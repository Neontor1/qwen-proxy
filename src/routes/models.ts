/**
 * GET /v1/models — OpenAI-style model list. Merges upstream models when a
 * healthy session is available (best effort, cached 5 min).
 */
import type { Context } from 'hono';
import { accountManager } from '../services/accountManager.js';
import { getSession } from '../services/auth.js';
import { modelRouter } from '../services/modelRouter.js';
import { getProvider } from '../services/qwen.js';
import { qwenModels } from '../services/qwenModels.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('models-route');

const upstreamCache: { ts: number; ok: boolean } = { ts: 0, ok: false };
const UPSTREAM_TTL = 5 * 60 * 1000;

async function refreshUpstreamModels(): Promise<void> {
  if (Date.now() - upstreamCache.ts < UPSTREAM_TTL) return;
  upstreamCache.ts = Date.now();
  try {
    const account = accountManager.acquire();
    const session = await getSession(account);
    const list = await getProvider().listModels(session);
    if (list.length) {
      qwenModels.mergeUpstream(list);
      upstreamCache.ok = true;
    }
  } catch (err) {
    log.debug(`upstream model list unavailable: ${String(err)}`);
    upstreamCache.ok = false;
  }
}

export async function handleModels(c: Context): Promise<Response> {
  await refreshUpstreamModels();
  return c.json({ object: 'list', data: modelRouter.listWithAliases() });
}
