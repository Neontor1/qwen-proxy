/**
 * Config API (master-key protected):
 *   GET /api/config         — current effective config (secrets masked)
 *   GET /api/config/raw     — raw config.json text for the editor
 *   PUT /api/config         — validate + persist + hot reload {raw: string} or {patch: object}
 */
import type { Context } from 'hono';
import { configService } from '../services/configService.js';
import { maskSecret } from '../utils/ids.js';

function maskConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  if (typeof out.API_KEY === 'string' && out.API_KEY) out.API_KEY = maskSecret(out.API_KEY);
  if (typeof out.MASTER_KEY === 'string' && out.MASTER_KEY) out.MASTER_KEY = maskSecret(out.MASTER_KEY);
  if (Array.isArray(out.ACCOUNTS)) {
    out.ACCOUNTS = (out.ACCOUNTS as Array<Record<string, unknown>>).map((a) => ({
      ...a,
      password: typeof a.password === 'string' ? maskSecret(a.password) : a.password,
    }));
  }
  return out;
}

export function getConfig(c: Context): Response {
  return c.json(maskConfig(configService.get() as unknown as Record<string, unknown>));
}

export function getConfigRaw(c: Context): Response {
  return c.text(configService.rawFileContent());
}

export async function putConfig(c: Context): Promise<Response> {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be valid JSON' }, 400);
  }

  if (typeof body?.raw === 'string') {
    const problems = configService.validateText(body.raw);
    if (problems) return c.json({ error: 'Validation failed', problems }, 422);
    try {
      const next = JSON.parse(body.raw) as Record<string, unknown>;
      const cfg = configService.update(next);
      return c.json({ ok: true, config: maskConfig(cfg as unknown as Record<string, unknown>) });
    } catch (err) {
      return c.json({ error: String(err) }, 422);
    }
  }

  if (body?.patch && typeof body.patch === 'object') {
    try {
      const cfg = configService.update(body.patch);
      return c.json({ ok: true, config: maskConfig(cfg as unknown as Record<string, unknown>) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 422);
    }
  }

  return c.json({ error: 'Provide {raw: string} or {patch: object}' }, 400);
}
