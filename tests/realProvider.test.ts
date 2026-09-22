/**
 * This test file requires Bun runtime (Bun.serve) and is excluded from Node.js test runs.
 * Run with: bun test tests/realProvider.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest/globals';
import type { QwenSession } from '../src/services/qwen.js';

// Check if running in Bun - skip if not
const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';

if (!isBun) {
  console.warn('Skipping realProvider.test.ts - requires Bun runtime');
  describe('RealQwenProvider (Bun-only)', () => {
    it.skip('requires Bun runtime', () => {});
  });
} else {
  // Stub upstream that mimics the *drifted* chat.qwen.ai web API:
  // the legacy routes answer 405 Method Not Allowed, the current ones work.
  const seen: string[] = [];
  const stub = (globalThis as Record<string, any>).Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}`);
      if (req.method === 'POST' && url.pathname === '/api/v2/chats/') {
        return new Response('<html>405 Method Not Allowed</html>', { status: 405 });
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/chats/new') {
        return Response.json({ data: { id: 'chat_drift_1' } });
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/chat/completions') {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'drift ', phase: 'answer', status: 'typing' } }] })}\n\n`,
              ),
            );
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok', phase: 'answer', status: 'typing' } }] })}\n\n`,
              ),
            );
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: '', status: 'finished', phase: 'answer' } }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })}\n\n`,
              ),
            );
            c.close();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/chats/chat_drift_1') {
        // legacy completions route must NOT be used when the new one works
        return new Response('405 Method Not Allowed', { status: 405 });
      }
      return new Response('404', { status: 404 });
    },
  });
  process.env.QWEN_BASE_URL = `http://127.0.0.1:${stub.port}`;
  // force the LEGACY create-chat path first so we exercise the 405 fallback
  process.env.QWEN_CREATE_CHAT_PATH = '/api/v2/chats/';
  afterAll(() => stub.stop(true));

  const { RealQwenProvider } = await import('../src/services/realProvider.js');

  const session: QwenSession = {
    accountId: 'acc_test',
    email: 'drift@test.dev',
    tokens: { token: 'jwt', cookies: 'cna=x; token=y', expiresAt: Date.now() + 3_600_000 },
    createdAt: Date.now(),
    lastUsed: Date.now(),
  };

  // Stub #2: mimics the WAF that silently empties streams for "heavy" payloads
  // (thinking enabled OR a tool-laden prompt) and streams only for reduced ones.
  const stub2 = (globalThis as Record<string, any>).Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/api/v2/chats/new') {
        return Response.json({ data: { id: 'chat_ladder' } });
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/chat/completions') {
        return req.text().then((raw) => {
          const body = JSON.parse(raw);
          const m0 = body.messages?.[0] ?? {};
          const heavy =
            m0.feature_config?.thinking_enabled === true || String(m0.content ?? '').includes('get_weather');
          const enc = new TextEncoder();
          if (heavy) {
            return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
          }
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: 'laddered ', phase: 'answer', status: 'typing' } }] })}\n\n`,
                ),
              );
              c.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok', status: 'finished', phase: 'answer' } }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } })}\n\n`,
                ),
              );
              c.close();
            },
          });
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        });
      }
      return new Response('404', { status: 404 });
    },
  });

  describe('empty-stream ladder (WAF payload degradation)', () => {
    it('climbs from heavy payload to a streaming one', async () => {
      const prevBase = process.env.QWEN_BASE_URL;
      process.env.QWEN_BASE_URL = `http://127.0.0.1:${stub2.port}`;
      const { RealQwenProvider } = await import('../src/services/realProvider.js');
      const provider = new RealQwenProvider();
      const events: any[] = [];
      for await (const ev of provider.streamChat(session, {
        model: 'qwen3.8-max',
        prompt: 'You have tools: get_weather(city). User: hi',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        thinkingEnabled: true,
      })) {
        events.push(ev);
      }
      process.env.QWEN_BASE_URL = prevBase;
      const text = events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join('');
      expect(text).toContain('laddered');
      expect(events.some((e) => e.type === 'finish')).toBe(true);
    });
    afterAll(() => stub2.stop(true));
  });

  describe('real provider survives upstream route drift', () => {
    it('create-chat falls back from 405 legacy path to /api/v2/chats/new', async () => {
      const provider = new RealQwenProvider();
      const events: any[] = [];
      for await (const ev of provider.streamChat(session, {
        model: 'qwen3.8-max',
        prompt: 'hi',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        events.push(ev);
      }
      const text = events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join('');
      expect(text).toContain('drift');
      expect(events.some((e) => e.type === 'finish')).toBe(true);

      // legacy create-chat was tried, got 405, then the new path succeeded
      expect(seen).toContain('POST /api/v2/chats/');
      expect(seen).toContain('POST /api/v2/chats/new');
      // completions went to the current route, not the legacy per-chat one
      expect(seen).toContain('POST /api/v2/chat/completions');
      expect(seen).not.toContain('POST /api/v2/chats/chat_drift_1');
    });
  });
}
