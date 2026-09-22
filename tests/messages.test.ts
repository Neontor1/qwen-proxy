import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QWEN_PROXY_HOME = mkdtempSync(path.join(os.tmpdir(), 'qg-anthropic-'));
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
accountManager.add('anthropic@mock.dev', 'pw');

const app = buildApp();

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const messagesBody = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Say hi' }],
  ...extra,
});

/** Split an SSE payload into `{event, data}` pairs. */
function parseSse(text: string): Array<{ event: string | null; data: any }> {
  return text
    .split(/\n\n/)
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      let event: string | null = null;
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      const raw = dataLines.join('\n');
      return { event, data: raw && raw !== '[DONE]' ? JSON.parse(raw) : raw };
    });
}

describe('Anthropic Messages API (/v1/messages)', () => {
  it('non-streaming: returns an Anthropic message object', async () => {
    const res = await post('/v1/messages', messagesBody());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBe('message');
    expect(json.role).toBe('assistant');
    expect(json.id.startsWith('msg_')).toBe(true);
    expect(json.content[0].type).toBe('text');
    expect(json.content[0].text.length).toBeGreaterThan(5);
    expect(json.stop_reason).toBe('end_turn');
    expect(json.stop_sequence).toBeNull();
    expect(json.usage.input_tokens).toBeGreaterThan(0);
    expect(json.usage.output_tokens).toBeGreaterThan(0);
    // no OpenAI leftovers
    expect(json.choices).toBeUndefined();
  });

  it('streaming: emits named Anthropic SSE events in order', async () => {
    const res = await post('/v1/messages', messagesBody({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const frames = parseSse(text);
    const names = frames.map((f) => f.event);

    expect(names[0]).toBe('message_start');
    expect(names).toContain('content_block_start');
    expect(names).toContain('content_block_delta');
    expect(names).toContain('content_block_stop');
    expect(names).toContain('message_delta');
    expect(names[names.length - 1]).toBe('message_stop');
    // Anthropic streams must NOT end with OpenAI's sentinel
    expect(text).not.toContain('[DONE]');

    const start = frames[0]!.data;
    expect(start.message.role).toBe('assistant');
    expect(start.message.usage.input_tokens).toBeGreaterThan(0);

    const deltas = frames.filter((f) => f.event === 'content_block_delta');
    expect(deltas[0]!.data.delta.type).toBe('text_delta');
    const joined = deltas.map((d) => d.data.delta.text ?? '').join('');
    expect(joined.length).toBeGreaterThan(5);

    const msgDelta = frames.filter((f) => f.event === 'message_delta').pop()!;
    expect(msgDelta.data.delta.stop_reason).toBe('end_turn');
    expect(msgDelta.data.usage.output_tokens).toBeGreaterThan(0);
  });

  it('converts tools (input_schema) and returns tool_use blocks', async () => {
    const res = await post(
      '/v1/messages',
      messagesBody({
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Check the weather via tool call please' }],
        tools: [
          {
            name: 'get_weather',
            description: 'Weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const toolUse = json.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect(toolUse.name).toBe('get_weather');
    expect(toolUse.id.length).toBeGreaterThan(3);
    expect(typeof toolUse.input).toBe('object');
    expect(toolUse.input).toHaveProperty('city');
    expect(json.stop_reason).toBe('tool_use');
  });

  it('streams tool_use as input_json_delta blocks', async () => {
    const res = await post(
      '/v1/messages',
      messagesBody({
        model: 'qwen3-coder-plus',
        stream: true,
        messages: [{ role: 'user', content: 'Check the weather via tool call please' }],
        tools: [
          {
            name: 'get_weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        ],
      }),
    );
    const frames = parseSse(await res.text());
    const toolStart = frames.find(
      (f) => f.event === 'content_block_start' && f.data.content_block?.type === 'tool_use',
    );
    expect(toolStart).toBeTruthy();
    expect(toolStart!.data.content_block.name).toBe('get_weather');
    const jsonDelta = frames.find(
      (f) => f.event === 'content_block_delta' && f.data.delta?.type === 'input_json_delta',
    );
    expect(jsonDelta).toBeTruthy();
    expect(JSON.parse(jsonDelta!.data.delta.partial_json)).toHaveProperty('city');
  });

  it('accepts system + tool_result turns (multi-turn tool loop)', async () => {
    const res = await post(
      '/v1/messages',
      messagesBody({
        system: [{ type: 'text', text: 'You are terse.' }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: { city: 'Paris' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_abc', content: 'Sunny, 21C' }],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBe('message');
    expect(json.content.length).toBeGreaterThan(0);
  });

  it('supports thinking blocks when extended thinking is enabled', async () => {
    const res = await post(
      '/v1/messages',
      messagesBody({ thinking: { type: 'enabled', budget_tokens: 1024 } }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // mock provider emits reasoning → must surface as a thinking block
    const types = json.content.map((b: any) => b.type);
    expect(types).toContain('thinking');
    expect(types).toContain('text');
    expect(types.indexOf('thinking')).toBeLessThan(types.indexOf('text'));
  });

  it('POST /v1/messages/count_tokens returns an estimate', async () => {
    const res = await post('/v1/messages/count_tokens', {
      model: 'claude-sonnet-4-5',
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'Hello there' }],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.input_tokens).toBe('number');
    expect(json.input_tokens).toBeGreaterThan(0);
  });

  it('validates the request (Anthropic error envelope)', async () => {
    const res = await post('/v1/messages', { model: 'claude-sonnet-4-5' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('invalid_request_error');
    expect(json.error.message).toContain('messages');
  });

  it('accepts x-api-key authentication (Claude Code style)', async () => {
    configService.update({ API_KEY: 'sk-anthropic-test' });
    const denied = await post('/v1/messages', messagesBody());
    expect(denied.status).toBe(401);

    const withApiKey = await post('/v1/messages', messagesBody(), { 'x-api-key': 'sk-anthropic-test' });
    expect(withApiKey.status).toBe(200);

    const withBearer = await post('/v1/messages', messagesBody(), {
      Authorization: 'Bearer sk-anthropic-test',
    });
    expect(withBearer.status).toBe(200);
    configService.update({ API_KEY: '' });
  });

  it('503 without accounts uses the Anthropic error shape', async () => {
    const ids = accountManager.list().map((a) => a.id);
    for (const id of ids) accountManager.remove(id);
    const res = await post('/v1/messages', messagesBody());
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.type).toBe('error');
    expect(json.error.type).toBe('api_error');
    for (const id of ids) void id;
    accountManager.add('anthropic@mock.dev', 'pw');
  });
});
