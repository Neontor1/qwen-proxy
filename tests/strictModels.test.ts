import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QWEN_PROXY_HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-models-'));
process.env.PROVIDER = 'mock';
process.env.MOCK_DELAY_MS = '1';
// rate limiting has its own suite (tests/rateLimit.test.ts); env vars leak across
// files when `bun test` runs everything in one process, so pin it off here
process.env.RATE_LIMIT_ENABLED = 'false';

const { buildApp } = await import('../src/app.js');
const { accountManager } = await import('../src/services/accountManager.js');
const { configService } = await import('../src/services/configService.js');

configService.load(true);
accountManager.load();
accountManager.add('models@mock.dev', 'pw');
const app = buildApp();

const chat = (model: string) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('model routing transparency', () => {
  it('falls back for unknown models but advertises it via headers', async () => {
    const res = await chat('definitely-not-a-model');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-model-routed-from')).toBe('definitely-not-a-model');
    expect(res.headers.get('x-model-resolved')).toBe('qwen3.8-max');
    const json = await res.json();
    expect(json.model).toBe('qwen3.8-max');
  });

  it('exposes alias resolution the same way', async () => {
    const res = await chat('claude-sonnet-4-5');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-model-resolved')).toBe('qwen3.8-max');
  });

  it('GET /v1/models advertises Claude Code catalog names', async () => {
    const res = await app.request('/v1/models');
    const ids = ((await res.json()) as any).data.map((m: any) => m.id);
    expect(ids).toContain('claude-sonnet-4-5');
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids[0]).toBe('qwen3.8-max');
  });

  it('every Claude Code catalog name lands on the proven qwen3.8-max', async () => {
    for (const name of [
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-1',
      'claude-haiku-4-5',
      'gpt-4o',
    ]) {
      const res = await chat(name);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-model-resolved')).toBe('qwen3.8-max');
    }
  });

  it('STRICT_MODELS=true rejects unknown models with the catalog', async () => {
    configService.update({ STRICT_MODELS: true });
    const res = await chat('definitely-not-a-model');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe('invalid_request_error');
    expect(json.error.message).toContain('Unknown model');
    expect(json.error.message).toContain('qwen3.8-max');
    // known ids still work
    expect((await chat('qwen3-plus')).status).toBe(200);
    expect((await chat('claude-3-5-haiku-latest')).status).toBe(200);
    configService.update({ STRICT_MODELS: false });
  });

  it('headers are present on streaming responses too', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nope-2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-model-routed-from')).toBe('nope-2');
    await res.text();
  });
});
