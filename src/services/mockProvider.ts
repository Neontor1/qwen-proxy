/**
 * Mock Qwen provider — deterministic simulator of chat.qwen.ai used for
 * tests, demos and offline development. Exercises the ENTIRE pipeline:
 * streaming deltas, think tags, XML tool-call artifacts, reasoning events,
 * usage stats, rate limiting and auth failures.
 *
 * Behaviour triggers (by account email):
 *   *@fail.*        → login fails
 *   *@ratelimit.*   → streamChat fails with 429 once per 30s
 *   *@slow.*        → 10x chunk delay
 *   *@flaky.*       → every other request fails with a 500
 */
import { createLogger } from '../utils/logger.js';
import {
  type AuthTokens,
  type ChatRequestParams,
  QwenError,
  type QwenProvider,
  type QwenSession,
  type QwenStreamEvent,
} from './qwen.js';

const log = createLogger('mock');

const CHUNK_DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 12);

function fakeJwt(email: string, ttlSec = 3600): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: email, email, iat: now, exp: now + ttlSec })}.mock-signature`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Build the XML tool-call artifact exactly like Qwen leaks it into text. */
function buildToolArtifact(toolName: string, params: Record<string, string>): string {
  const OPEN_FC = ['<', 'function_calls', '>'].join('');
  const CLOSE_FC = ['<', '/', 'function_calls', '>'].join('');
  const OPEN_INVOKE = ['<', 'invoke name="', toolName, '">'].join('');
  const CLOSE_INVOKE = ['<', '/', 'invoke', '>'].join('');
  const CLOSE_PARAM = ['<', '/', 'parameter', '>'].join('');
  const body = Object.entries(params)
    .map(([k, v]) => `${['<', 'parameter name="', k, '">'].join('')}${v}${CLOSE_PARAM}`)
    .join('\n');
  return `\n${OPEN_FC}\n${OPEN_INVOKE}\n${body}\n${CLOSE_INVOKE}\n${CLOSE_FC}\n`;
}

export class MockQwenProvider implements QwenProvider {
  readonly kind = 'mock' as const;
  private flakyState = new Map<string, number>();
  private rateLimitHits = new Map<string, number>();

  async probe(tokens: AuthTokens): Promise<{ ok: boolean; message: string }> {
    if (tokens.cookies?.includes('fail')) return { ok: false, message: 'mock: session rejected' };
    return { ok: true, message: 'mock session accepted' };
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    log.debug(`mock login for ${email}`);
    await sleep(5);
    if (/@fail\./i.test(email) || password === 'wrong-password') {
      throw new QwenError('Invalid email or password (mock)', {
        status: 401,
        authFailed: true,
        retryable: false,
      });
    }
    return {
      token: fakeJwt(email),
      refreshToken: fakeJwt(email, 86400 * 30),
      expiresAt: Date.now() + 3600_000,
    };
  }

  async refresh(tokens: AuthTokens, email: string): Promise<AuthTokens> {
    log.debug(`mock token refresh for ${email}`);
    if (!tokens.token) throw new QwenError('Missing token (mock)', { status: 401, authFailed: true });
    return { ...tokens, token: fakeJwt(email), expiresAt: Date.now() + 3600_000 };
  }

  async listModels(): Promise<Array<{ id: string; name?: string }>> {
    return [
      { id: 'qwen3-max', name: 'Qwen3-Max' },
      { id: 'qwen3-plus', name: 'Qwen3-Plus' },
      { id: 'qwen3-flash', name: 'Qwen3-Flash' },
      { id: 'qwen3-coder-plus', name: 'Qwen3-Coder-Plus' },
    ];
  }

  async *streamChat(session: QwenSession, params: ChatRequestParams): AsyncGenerator<QwenStreamEvent> {
    const email = session.email;
    const delay = /@slow\./i.test(email) ? CHUNK_DELAY_MS * 10 : CHUNK_DELAY_MS;

    if (/@flaky\./i.test(email)) {
      const n = (this.flakyState.get(session.accountId) ?? 0) + 1;
      this.flakyState.set(session.accountId, n);
      if (n % 2 === 1) {
        yield { type: 'error', error: new QwenError('Upstream 500 (mock flaky)', { status: 500 }) };
        return;
      }
    }
    if (/@ratelimit\./i.test(email)) {
      const last = this.rateLimitHits.get(session.accountId) ?? 0;
      if (Date.now() - last > 30_000) {
        this.rateLimitHits.set(session.accountId, Date.now());
        yield {
          type: 'error',
          error: new QwenError('Requests rate-limited (mock 429)', { status: 429, rateLimited: true }),
        };
        return;
      }
    }

    const tool = params.tools?.[0];
    const toolName = tool?.function?.name ?? tool?.name;
    const wantsTool = !!toolName && /weather|tool|function|call/i.test(params.prompt);

    // 1) reasoning phase — think block that the content filter must strip
    const thinkOpen = ['<', 'think', '>'].join('');
    const thinkClose = ['<', '/', 'think', '>'].join('');
    yield { type: 'reasoning', text: `${thinkOpen}Let me analyze this request step by step...${thinkClose}` };

    if (wantsTool) {
      // 2) tool call embedded in text as an XML artifact
      const artifact = buildToolArtifact(toolName!, { city: '"Paris"', units: '"celsius"' });
      yield { type: 'delta', text: 'I will check the weather for you.' };
      await sleep(delay, params.signal);
      for (const piece of artifact.match(/[\s\S]{1,12}/g) ?? []) {
        yield { type: 'delta', text: piece };
        await sleep(Math.max(1, delay / 3), params.signal);
      }
      yield { type: 'usage', usage: { input_tokens: 42, output_tokens: 30, total_tokens: 72 } };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }

    // 3) normal answer, streamed word by word (includes a stray artifact to clean)
    const fnOpen = ['<', 'function=leftover_artifact', '>'].join('');
    const answer = `Hello from the mock Qwen provider! You asked about: "${params.prompt.slice(0, 60)}". Model: ${params.model}. ${fnOpen} This line proves content filtering works: the artifact tag disappears while formatting — markdown, lists, code — is preserved.\n\n- streaming ✓\n- rotation ✓\n- filtering ✓`;
    const words = answer.match(/\S+\s*/g) ?? [answer];
    let emitted = 0;
    for (const w of words) {
      if (params.signal?.aborted) throw new Error('aborted');
      yield { type: 'delta', text: w };
      emitted += w.length;
      await sleep(delay, params.signal);
    }
    yield {
      type: 'usage',
      usage: {
        input_tokens: 21,
        output_tokens: Math.max(1, Math.ceil(emitted / 4)),
        total_tokens: 21 + Math.max(1, Math.ceil(emitted / 4)),
      },
    };
    yield { type: 'finish', reason: 'stop' };
  }
}
