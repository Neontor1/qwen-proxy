import { describe, expect, it } from 'vitest/globals';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QWEN_PROXY_HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-chat-'));
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
accountManager.add('integration@mock.dev', 'pw');

const app = buildApp();

const chatBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'qwen3-max',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Say hi' },
    ],
    ...extra,
  });

describe('OpenAI-compatible API (mock provider)', () => {
  it('GET /v1/models lists the catalog', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe('list');
    expect(json.data.length).toBeGreaterThanOrEqual(4);
  });

  it('non-streaming completion shape', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: chatBody(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].message.role).toBe('assistant');
    expect(json.choices[0].message.content.length).toBeGreaterThan(10);
    expect(json.choices[0].finish_reason).toBe('stop');
    expect(json.usage.total_tokens).toBeGreaterThan(0);
  });

  it('streaming completion emits SSE with [DONE]', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: chatBody({ stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const chunks = text
      .split('\n\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].object).toBe('chat.completion.chunk');
    const joined = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(joined.length).toBeGreaterThan(10);
    const lastWithFinish = chunks.filter((c) => c.choices?.[0]?.finish_reason).pop();
    expect(lastWithFinish?.choices?.[0]?.finish_reason).toBe('stop');
  });

  it('tool calls are converted to OpenAI format', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: chatBody({
        messages: [{ role: 'user', content: 'Check the weather via tool call please' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
      }),
    });
    const json = await res.json();
    const tc = json.choices[0].message.tool_calls;
    expect(Array.isArray(tc)).toBe(true);
    expect(tc[0].type).toBe('function');
    expect(tc[0].function.name).toBe('get_weather');
    expect(JSON.parse(tc[0].function.arguments)).toHaveProperty('city');
    expect(json.choices[0].finish_reason).toBe('tool_calls');
  });

  it('validates requests (400 on garbage)', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe('invalid_request_error');
  });

  it('health endpoint reports provider and accounts', async () => {
    const res = await app.request('/health');
    const json = await res.json();
    expect(json.provider).toBe('mock');
    expect(json.accounts.total).toBeGreaterThanOrEqual(1);
  });

  it('bearer auth enforced when API_KEY set', async () => {
    configService.update({ API_KEY: 'sk-test-123' });
    const denied = await app.request('/v1/models');
    expect(denied.status).toBe(401);
    const ok = await app.request('/v1/models', { headers: { Authorization: 'Bearer sk-test-123' } });
    expect(ok.status).toBe(200);
    configService.update({ API_KEY: '' });
  });
});
