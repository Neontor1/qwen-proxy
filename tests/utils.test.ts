import { describe, expect, it } from 'vitest';
import { decodeJwt, jwtExpiresInMs, maskEmail, maskSecret } from '../src/utils/ids.js';
import { retry } from '../src/utils/retry.js';
import { SseParser, sseFormat } from '../src/utils/streaming.js';
import { estimateMessagesTokens, estimateTokens } from '../src/utils/tokenEstimator.js';

describe('SSE utils', () => {
  it('formats events', () => {
    expect(sseFormat({ a: 1 })).toBe('data: {"a":1}\n\n');
    expect(sseFormat('x', 'ev')).toBe('event: ev\ndata: x\n\n');
  });

  it('parses split streams', () => {
    const got: string[] = [];
    const p = new SseParser((d) => got.push(d));
    p.push('data: one\n\nda');
    p.push('ta: two\n\n');
    p.push('data: three');
    p.flush();
    expect(got).toEqual(['one', 'two', 'three']);
  });
});

describe('token estimator', () => {
  it('counts CJK heavier than latin', () => {
    expect(estimateTokens('привет мир hello world')).toBeGreaterThan(0);
    expect(estimateTokens('你好世界')).toBeGreaterThanOrEqual(4);
  });
  it('adds message overhead', () => {
    expect(estimateMessagesTokens([{ role: 'user', content: 'hi' }])).toBeGreaterThan(estimateTokens('hi'));
  });
});

describe('ids/jwt', () => {
  it('decodes jwt expiry', () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${enc({ alg: 'none' })}.${enc({ exp: Math.floor(Date.now() / 1000) + 60 })}.sig`;
    const ms = jwtExpiresInMs(token);
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);
    expect(decodeJwt('garbage')).toBeNull();
  });
  it('masks secrets', () => {
    expect(maskSecret('sk-abcdef123456', 3)).toMatch(/^sk-\*+$/);
    expect(maskEmail('user@example.com')).toBe('us**@example.com');
  });
});

describe('retry', () => {
  it('retries until success', async () => {
    let n = 0;
    const out = await retry(
      async () => {
        n++;
        if (n < 3) throw new Error('boom');
        return 'ok';
      },
      { maxAttempts: 5, baseDelayMs: 1 },
    );
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('gives up after max attempts', async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n++;
          throw new Error('always');
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('always');
    expect(n).toBe(2);
  });

  it('aborts early via shouldAbort', async () => {
    let n = 0;
    await expect(
      retry(
        async () => {
          n++;
          throw new Error('fatal');
        },
        { maxAttempts: 5, baseDelayMs: 1, shouldAbort: () => true },
      ),
    ).rejects.toThrow('fatal');
    expect(n).toBe(1);
  });
});
