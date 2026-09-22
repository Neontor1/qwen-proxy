/**
 * Real Qwen provider — talks to chat.qwen.ai.
 *
 * Auth flow (endpoints overridable via env, see below):
 *   POST /api/v1/auths/          {email, password}          → data.token (JWT)
 *   POST /api/v1/auths/refresh   Bearer                     → data.token
 *   GET  /api/v2/models?         Bearer                     → data[]
 * Chat flow (one fresh chat per request):
 *   POST /api/v2/chats/          Bearer {chat_mode:"normal"} → data.id
 *   POST /api/v2/chats/{id}?chat_mode=normal  (SSE)          → choices[0].delta stream
 *
 * Env overrides for upstream drift:
 *   QWEN_BASE_URL, QWEN_AUTH_PATH, QWEN_REFRESH_PATH, QWEN_MODELS_PATH,
 *   QWEN_CREATE_CHAT_PATH, QWEN_CHAT_SEND_PATH (use {chat_id} placeholder),
 *   QWEN_WEB_VERSION (SPA build id sent in the `version` header).
 * Known path variants are also tried automatically on 404/405, so a moved
 * route degrades to a warning instead of an outage.
 *
 * All requests carry baxia anti-bot headers (utils/bxUaGenerator.ts) and are
 * recorded by the Network debugger when NETWORK_DEBUG is on.
 */
import { WEB_ACCEPT_LANGUAGE, WEB_USER_AGENT, getBaxiaTokens } from '../utils/bxUaGenerator.js';
import { mergeCookieHeaders } from '../utils/cookies.js';
import { jwtExpiresInMs, uuid } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';
import { SseParser } from '../utils/streaming.js';
import { configService } from './configService.js';
import { networkDebug } from './networkDebug.js';
import { renderPrompt } from './promptRenderer.js';
import {
  type AuthTokens,
  type ChatRequestParams,
  QwenError,
  type QwenProvider,
  type QwenSession,
  type QwenStreamEvent,
} from './qwen.js';

const log = createLogger('qwen-real');

const endpoints = () => ({
  base: (process.env.QWEN_BASE_URL || configService.get().QWEN_BASE_URL).replace(/\/$/, ''),
  auth: process.env.QWEN_AUTH_PATH || '/api/v1/auths/signin',
  refresh: process.env.QWEN_REFRESH_PATH || '/api/v1/auths/refresh',
  models: process.env.QWEN_MODELS_PATH || '/api/v2/models?',
  createChat: process.env.QWEN_CREATE_CHAT_PATH || '/api/v2/chats/new',
  sendChat: process.env.QWEN_CHAT_SEND_PATH || '/api/v2/chat/completions?chat_id={chat_id}',
});

function commonHeaders(
  tokens?: { bxUa: string; bxUmidToken: string; bxV: string; cookies?: string },
  bearer?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://chat.qwen.ai',
    Referer: 'https://chat.qwen.ai/',
    source: 'web',
    version: process.env.QWEN_WEB_VERSION || '0.2.83',
    'User-Agent': WEB_USER_AGENT,
    'Accept-Language': WEB_ACCEPT_LANGUAGE,
    'x-request-id': uuid(),
  };
  if (tokens) {
    h['bx-ua'] = tokens.bxUa;
    h['bx-umidtoken'] = tokens.bxUmidToken;
    h['bx-v'] = tokens.bxV;
    if (tokens.cookies) h.Cookie = tokens.cookies;
  }
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  return h;
}

function classifyUpstreamError(status: number, rawText: string, fallbackMsg: string): QwenError {
  const lower = rawText.toLowerCase();
  let message = fallbackMsg;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(rawText);
    const d = parsed?.data ?? parsed?.detail ?? parsed;
    message = d?.details || d?.message || d?.code || message;
    code = d?.code;
  } catch {
    if (rawText && rawText.length < 500) message = rawText;
  }
  const riskControlled =
    /rgv.?587/i.test(rawText) || lower.includes('risk control') || lower.includes('aliyun_waf');
  const rateLimited =
    status === 429 ||
    riskControlled ||
    lower.includes('throttl') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests');
  const authFailed =
    status === 401 ||
    status === 403 ||
    /invalid_cred|invalid email|invalid password/i.test(rawText) ||
    (lower.includes('token') && (lower.includes('expired') || lower.includes('invalid')));
  return new QwenError(message, {
    status: status || 502,
    code,
    rateLimited,
    authFailed,
    retryable: rateLimited || status >= 500 || status === 0,
  });
}

interface UpstreamSseJson {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      phase?: string;
      extra?: { summary_thought?: { content?: unknown } };
    };
    finish_reason?: string | null;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: unknown;
  data?: { code?: string; message?: string; details?: string };
  success?: boolean;
}

export class RealQwenProvider implements QwenProvider {
  readonly kind = 'real' as const;

  private debugEnabled(): boolean {
    return configService.get().NETWORK_DEBUG;
  }

  private async post(
    url: string,
    body: unknown,
    bearer?: string,
    accountId?: string | null,
    cookieHeader?: string,
  ): Promise<Response> {
    const bx = await getBaxiaTokens();
    const headers = commonHeaders(bx, bearer);
    if (cookieHeader) headers.Cookie = mergeCookieHeaders(headers.Cookie, cookieHeader);
    return this.doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) }, accountId, body);
  }

  private async get(
    url: string,
    bearer?: string,
    accountId?: string | null,
    cookieHeader?: string,
  ): Promise<Response> {
    const bx = await getBaxiaTokens();
    const headers = commonHeaders(bx, bearer);
    if (cookieHeader) headers.Cookie = mergeCookieHeaders(headers.Cookie, cookieHeader);
    return this.doFetch(url, { method: 'GET', headers }, accountId);
  }

  /** Liveness probe for cookie accounts: the models endpoint accepts a session. */
  async probe(tokens: AuthTokens): Promise<{ ok: boolean; message: string }> {
    const ep = endpoints();
    try {
      const resp = await this.get(`${ep.base}${ep.models}`, tokens.token || undefined, null, tokens.cookies);
      const text = await resp.text();
      if (resp.ok) return { ok: true, message: 'Session accepted by chat.qwen.ai' };
      return {
        ok: false,
        message: classifyUpstreamError(resp.status, text, `probe HTTP ${resp.status}`).message,
      };
    } catch (err) {
      return { ok: false, message: `probe network error: ${String(err)}` };
    }
  }

  private async doFetch(
    url: string,
    init: RequestInit,
    accountId?: string | null,
    bodyPreview?: unknown,
  ): Promise<Response> {
    const handle = networkDebug.begin({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: bodyPreview,
      accountId,
      enabled: this.debugEnabled(),
    });
    try {
      const resp = await fetch(url, { ...init, signal: init.signal });
      handle.end(resp.status, resp.headers);
      return resp;
    } catch (err) {
      handle.end(null, null, null, String(err));
      throw err;
    }
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const ep = endpoints();
    const url = `${ep.base}${ep.auth}`;
    log.debug(`login attempt for ${email}`);
    let resp: Response;
    try {
      resp = await this.post(url, { email, password }, undefined, null);
    } catch (err) {
      throw new QwenError(`network error during login: ${String(err)}`, { status: 0 });
    }
    const text = await resp.text();
    if (!resp.ok) throw classifyUpstreamError(resp.status, text, `login failed HTTP ${resp.status}`);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw classifyUpstreamError(
        resp.status,
        text,
        'login returned non-JSON (possible captcha/risk control)',
      );
    }
    // success shapes seen across upstream versions: {token}, {data:{token}}, {data:{access_token}}
    const token = json?.token ?? json?.data?.token ?? json?.data?.access_token ?? json?.access_token;
    if (!token)
      throw classifyUpstreamError(
        resp.status,
        text,
        json?.data?.message ||
          json?.data?.details ||
          json?.detail?.details ||
          'login response contained no token',
      );
    log.debug('login ok, response keys', Object.keys(json?.data ?? json ?? {}).join(','));
    const expiresIn = jwtExpiresInMs(token);
    return {
      token,
      refreshToken: json?.data?.refresh_token,
      expiresAt: Date.now() + (expiresIn || 3600_000),
    };
  }

  async refresh(tokens: AuthTokens, email: string): Promise<AuthTokens> {
    const ep = endpoints();
    const url = `${ep.base}${ep.refresh}`;
    let resp: Response;
    try {
      resp = await this.post(url, {}, tokens.token, null);
    } catch (err) {
      log.warn(`refresh network error for ${email}, will require re-login: ${String(err)}`);
      throw new QwenError(`refresh network error: ${String(err)}`, { status: 0, authFailed: true });
    }
    const text = await resp.text();
    if (!resp.ok) {
      throw classifyUpstreamError(resp.status, text, `refresh failed HTTP ${resp.status}`);
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new QwenError('refresh returned non-JSON', { status: 502, authFailed: true });
    }
    const token = json?.data?.token ?? json?.token;
    if (!token) throw new QwenError('refresh response contained no token', { status: 502, authFailed: true });
    const expiresIn = jwtExpiresInMs(token);
    log.info(`token refreshed for ${email}`);
    return { ...tokens, token, expiresAt: Date.now() + (expiresIn || 3600_000) };
  }

  async listModels(session?: QwenSession | null): Promise<Array<{ id: string; name?: string }>> {
    const ep = endpoints();
    const resp = await this.get(
      `${ep.base}${ep.models}`,
      session?.tokens.token || undefined,
      session?.accountId,
      session?.tokens.cookies,
    );
    const text = await resp.text();
    if (!resp.ok) throw classifyUpstreamError(resp.status, text, `models HTTP ${resp.status}`);
    const json = JSON.parse(text);
    const list = json?.data ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((m: any) => ({ id: String(m?.id ?? ''), name: m?.name ? String(m.name) : undefined }))
      .filter((m) => m.id);
  }

  private async createChat(session: QwenSession, model: string, chatType: string): Promise<string> {
    const ep = endpoints();
    const body = {
      chat_mode: 'normal',
      model,
      sub_chat_type: chatType,
      title: '',
      timestamp: Date.now(),
    };
    // The SPA route has moved before (chats/ -> chats/new) and WILL move again:
    // try the configured path first, then known variants, skipping 404/405 and
    // "200 but no id" (stale `version` header symptom) instead of dying.
    const paths = [ep.createChat, '/api/v2/chats/new', '/api/v2/chats/'].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    let lastErr: QwenError | null = null;
    for (const path of paths) {
      const resp = await this.post(
        `${ep.base}${path}`,
        body,
        session.tokens.token || undefined,
        session.accountId,
        session.tokens.cookies,
      );
      const text = await resp.text();
      if (resp.status === 404 || resp.status === 405) {
        lastErr = classifyUpstreamError(resp.status, text, `create chat ${path} HTTP ${resp.status}`);
        log.warn(`create-chat ${path} rejected (${resp.status}) - trying next known path`);
        continue;
      }
      if (!resp.ok) throw classifyUpstreamError(resp.status, text, `create chat HTTP ${resp.status}`);
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw classifyUpstreamError(resp.status, text, 'create chat returned non-JSON (risk control?)');
      }
      const chatId = json?.data?.id ?? json?.id;
      if (!chatId) {
        lastErr = classifyUpstreamError(
          resp.status,
          text,
          json?.data?.message || `create chat ${path}: no id in response`,
        );
        log.warn(`create-chat ${path} returned no id - trying next known path`);
        continue;
      }
      return String(chatId);
    }
    throw lastErr ?? new QwenError('create chat failed on all known paths', { status: 502 });
  }

  /**
   * chat.qwen.ai's WAF silently degrades some payloads to an empty 200 stream
   * (observed: Claude Code's 30+ tools and/or enabled thinking). Ladder:
   * full payload -> no thinking -> no thinking & no tools, logging which
   * variant finally streamed, so the logs tell us what upstream choked on.
   */
  async *streamChat(session: QwenSession, params: ChatRequestParams): AsyncGenerator<QwenStreamEvent> {
    const variants: ChatRequestParams[] = [params];
    if (params.thinkingEnabled !== false) variants.push({ ...params, thinkingEnabled: false });
    if (params.tools?.length) {
      variants.push({
        ...params,
        thinkingEnabled: false,
        tools: undefined,
        // prompt is pre-rendered with the tool preamble — re-render without it
        prompt: renderPrompt(params.messages as any, undefined),
      });
    }

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]!;
      const gen = this.streamOnce(session, v);
      const pending: QwenStreamEvent[] = [];
      let sawContent = false;
      for (;;) {
        const step = await gen.next();
        if (step.done) break;
        pending.push(step.value);
        if (step.value.type === 'delta' || step.value.type === 'reasoning' || step.value.type === 'error') {
          sawContent = true;
          break;
        }
      }
      if (sawContent) {
        for (const ev of pending) yield ev;
        yield* gen;
        return;
      }
      if (i < variants.length - 1) {
        log.warn(
          `upstream returned an empty stream (thinking=${v.thinkingEnabled !== false}, tools=${String(!!v.tools?.length)}) - retrying with a reduced payload`,
        );
      }
    }
    yield {
      type: 'error',
      error: new QwenError(
        'upstream returned an empty stream on every payload variant (WAF fingerprint or unsupported payload); see docs/TROUBLESHOOTING.md',
        { status: 502, retryable: true },
      ),
    };
  }

  private async *streamOnce(
    session: QwenSession,
    params: ChatRequestParams,
  ): AsyncGenerator<QwenStreamEvent> {
    const ep = endpoints();
    const chatType = params.enableSearch ? 'search' : 't2t';
    const prompt = params.prompt || renderPrompt(params.messages as any, params.tools);

    const chatId = await this.createChat(session, params.model, chatType);
    const sendUrls = [
      ep.sendChat,
      '/api/v2/chat/completions?chat_id={chat_id}',
      '/api/v2/chats/{chat_id}?chat_mode=normal',
    ]
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((p) => `${ep.base}${p.replace('{chat_id}', chatId)}`);

    const bx = await getBaxiaTokens();
    const headers: Record<string, string> = {
      ...commonHeaders(bx, session.tokens.token || undefined),
      'x-accel-buffering': 'no',
    };
    if (session.tokens.cookies) {
      headers.Cookie = mergeCookieHeaders(headers.Cookie, session.tokens.cookies);
    }
    const body = {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: params.model,
      parent_id: null,
      messages: [
        {
          id: null,
          fid: uuid(),
          parentId: null,
          childrenIds: [uuid()],
          role: 'user',
          content: prompt,
          user_action: 'chat',
          files: [],
          timestamp: Date.now(),
          models: [params.model],
          model: '',
          chat_type: chatType,
          feature_config: {
            thinking_enabled: params.thinkingEnabled ?? true,
            output_schema: 'phase',
            research_mode: 'normal',
            auto_thinking: true,
            thinking_mode: 'Auto',
            thinking_format: 'summary',
            auto_search: !!params.enableSearch,
          },
          extra: { meta: { subChatType: chatType } },
          sub_chat_type: chatType,
          parent_id: null,
        },
      ],
      timestamp: Date.now(),
    };

    let resp: Response | null = null;
    for (const url of sendUrls) {
      const handle = networkDebug.begin({
        method: 'POST',
        url,
        headers,
        body,
        accountId: session.accountId,
        enabled: this.debugEnabled(),
      });
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: params.signal,
        });
      } catch (err) {
        handle.end(null, null, null, String(err));
        yield {
          type: 'error',
          error: new QwenError(`upstream network error: ${String(err)}`, { status: 0 }),
        };
        return;
      }
      handle.end(resp.status, resp.headers);
      if (resp.status === 404 || resp.status === 405) {
        await resp.text().catch(() => '');
        log.warn(`completions ${url.split('?')[0]} rejected (${resp.status}) - trying next known path`);
        resp = null;
        continue;
      }
      break;
    }
    if (!resp) {
      yield {
        type: 'error',
        error: new QwenError('chat completions rejected on all known paths (404/405)', { status: 405 }),
      };
      return;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      yield { type: 'error', error: classifyUpstreamError(resp.status, text, `chat HTTP ${resp.status}`) };
      return;
    }
    if (!resp.body) {
      yield { type: 'error', error: new QwenError('upstream returned no body', { status: 502 }) };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let finishSent = false;
    let sawError = false;

    const onData = (data: string) => {
      // events are queued and yielded below
      queue.push(data);
    };
    const queue: string[] = [];
    const parser = new SseParser(onData);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));

        while (queue.length) {
          const data = queue.shift()!;
          if (data === '[DONE]') continue;
          let json: UpstreamSseJson;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json.success === false || json.error || json.data?.code) {
            const errPayload = JSON.stringify(json);
            sawError = true;
            yield {
              type: 'error',
              error: classifyUpstreamError(200, errPayload, 'upstream error inside SSE stream'),
            };
            return;
          }
          const choice = json.choices?.[0];
          const delta = choice?.delta;
          if (delta) {
            const reasoning =
              delta.reasoning_content ??
              (delta.phase === 'thinking_summary'
                ? extractSummaryThought(delta.extra?.summary_thought?.content)
                : '') ??
              '';
            if (reasoning) yield { type: 'reasoning', text: reasoning };
            if (typeof delta.content === 'string' && delta.content)
              yield { type: 'delta', text: delta.content };
          }
          if (json.usage) yield { type: 'usage', usage: json.usage };
          if (choice?.finish_reason) {
            finishSent = true;
            yield { type: 'finish', reason: String(choice.finish_reason) };
          }
        }
      }
      parser.flush();
      while (queue.length) {
        const data = queue.shift()!;
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data) as UpstreamSseJson;
          const choice = json.choices?.[0];
          if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };
          if (json.usage) yield { type: 'usage', usage: json.usage };
        } catch {
          /* ignore */
        }
      }
      if (!finishSent && !sawError) yield { type: 'finish', reason: 'stop' };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || params.signal?.aborted) {
        yield { type: 'finish', reason: 'abort' };
      } else {
        yield { type: 'error', error: new QwenError(`stream read error: ${String(err)}`, { status: 0 }) };
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}

function extractSummaryThought(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : ((c as any)?.text ?? (c as any)?.content ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
