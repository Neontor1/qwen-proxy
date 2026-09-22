/**
 * POST /v1/chat/completions — OpenAI-compatible entry point.
 *
 * Pipeline: validate → route model → account rotation loop (acquire →
 * session → provider stream with first-event peek for transparent failover)
 * → stream (commits on first byte) or collect (failover until content
 * arrives) → log / monitor / health.
 *
 * The pipeline is dialect-agnostic: `runChatCompletion` accepts hooks so other
 * wire formats (Anthropic Messages API in `./messages.ts`) can reuse rotation,
 * failover, filtering, tool parsing, metrics and logging verbatim.
 */
import type { Context } from 'hono';
import { type Account, NoAccountAvailableError, accountManager } from '../services/accountManager.js';
import { getSession, recoverFromAuthFailure } from '../services/auth.js';
import { configService } from '../services/configService.js';
import { logStore } from '../services/logStore.js';
import { modelHealth } from '../services/modelHealth.js';
import { modelRouter } from '../services/modelRouter.js';
import { monitorStore } from '../services/monitorStore.js';
import { renderPrompt } from '../services/promptRenderer.js';
import { type ChatRequestParams, QwenError, type QwenStreamEvent, getProvider } from '../services/qwen.js';
import { qwenModels } from '../services/qwenModels.js';
import { toolNamesFromDefinitions } from '../tools/xmlToolParser.js';
import { completionId } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';
import { estimateMessagesTokens } from '../utils/tokenEstimator.js';
import {
  type CollectedCompletion,
  EarlyStreamError,
  buildCompletionObject,
  collectCompletion,
} from './chatNonStreaming.js';
import { type ChunkEmitter, type StreamResult, startStreaming } from './chatStreaming.js';
import type { ChunkMeta } from './chunkBuilders.js';
import { chatRequestSchema } from './schemas.js';

const log = createLogger('chat');

export interface ChatPipelineHooks {
  /** Label used in request logs and monitoring (default `/v1/chat/completions`). */
  route?: string;
  /** Builds the non-streaming response payload (default: OpenAI chat.completion). */
  buildBody?: (collected: CollectedCompletion, meta: ChunkMeta) => unknown;
  /** SSE dialect for streaming responses (default: OpenAI chunks). */
  emitter?: ChunkEmitter;
  /** Builds error payloads (default: OpenAI error envelope). */
  buildError?: (status: number, message: string) => unknown;
  /** Extra headers added to every response produced by this call. */
  headers?: Record<string, string>;
}

export async function handleChatCompletions(c: Context): Promise<Response> {
  return runChatCompletion(c);
}

/**
 * Run the full chat pipeline.
 * @param preParsedBody  already-parsed & converted request (used by /v1/messages);
 *                       when omitted the JSON body is read from the request.
 */
export async function runChatCompletion(
  c: Context,
  hooks: ChatPipelineHooks = {},
  preParsedBody?: unknown,
): Promise<Response> {
  const route = hooks.route ?? '/v1/chat/completions';
  const cfg = configService.get();
  const startedAt = Date.now();
  monitorStore.requestStarted();

  const respondError = (status: number, message: string, model: string): Response =>
    fail(c, status, message, startedAt, model, route, hooks);

  let body: unknown = preParsedBody;
  if (body === undefined) {
    try {
      body = await c.req.json();
    } catch {
      return respondError(400, 'Request body must be valid JSON', '');
    }
  }
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return respondError(400, msg, String((body as Record<string, unknown>)?.model ?? ''));
  }
  const req = parsed.data;

  // ── model routing (with optional strictness) ──────────────────────────────
  const known = qwenModels.has(req.model);
  if (!known && cfg.STRICT_MODELS) {
    const available = qwenModels
      .all()
      .map((m) => m.id)
      .join(', ');
    return respondError(
      400,
      `Unknown model '${req.model}'. Available models: ${available}. ` +
        'Set STRICT_MODELS=false to route unknown ids to the default model instead.',
      req.model,
    );
  }
  const routing = modelRouter.resolve(req.model);
  const extraHeaders: Record<string, string> = { ...(hooks.headers ?? {}) };
  if (!known) {
    // Silent fallback kept for client compatibility, but always advertised.
    extraHeaders['X-Model-Routed-From'] = req.model;
    extraHeaders['X-Model-Resolved'] = routing.resolved;
    log.warn(
      `unknown model '${req.model}' routed to '${routing.resolved}' (set STRICT_MODELS=true to reject instead)`,
    );
  } else if (routing.aliased) {
    extraHeaders['X-Model-Routed-From'] = req.model;
    extraHeaders['X-Model-Resolved'] = routing.resolved;
  }
  for (const [k, v] of Object.entries(extraHeaders)) c.header(k, v);

  const streaming = cfg.STREAMING_MODE === 'on' ? true : cfg.STREAMING_MODE === 'off' ? false : !!req.stream;
  const toolNames = toolNamesFromDefinitions(req.tools as unknown[] | undefined);
  const meta = { id: completionId(), created: Math.floor(Date.now() / 1000), model: routing.resolved };
  const promptTokens = estimateMessagesTokens(req.messages as Array<{ role?: string; content?: unknown }>);

  const params: ChatRequestParams = {
    model: routing.resolved,
    prompt: renderPrompt(req.messages as any, req.tools as any),
    messages: req.messages as any,
    tools: req.tools as any,
    temperature: req.temperature,
    maxTokens: req.max_tokens ?? req.max_completion_tokens,
    enableSearch: req.enable_search,
    thinkingEnabled: req.thinking ?? req.reasoning_effort !== 'none',
    signal: c.req.raw.signal,
  };

  const clientIp =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;

  const record = (info: {
    status: number;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
    error: string | null;
    durationMs: number;
    stream: boolean;
    accountId: string | null;
    accountEmail: string | null;
    toolCalls: number;
    contentBytes: number;
  }) => {
    const ok = info.status < 400 && !info.error;
    if (info.accountId) {
      if (ok) accountManager.reportSuccess(info.accountId, info.usage?.total_tokens ?? 0);
    }
    if (ok) modelHealth.recordSuccess(routing.resolved);
    else modelHealth.recordError(routing.resolved, info.error ?? `status ${info.status}`);
    monitorStore.record({
      ts: Date.now(),
      model: routing.resolved,
      accountId: info.accountId,
      durationMs: info.durationMs,
      ok,
      status: info.status,
      totalTokens: info.usage?.total_tokens ?? null,
    });
    logStore.add({
      route,
      model: routing.resolved,
      accountId: info.accountId,
      accountEmail: info.accountEmail,
      durationMs: info.durationMs,
      status: info.status,
      stream: info.stream,
      promptTokens: info.usage?.prompt_tokens ?? promptTokens,
      completionTokens: info.usage?.completion_tokens ?? null,
      totalTokens: info.usage?.total_tokens ?? null,
      error: info.error,
      clientIp,
    });
    log.info(
      `${info.stream ? 'stream' : 'completion'} finished: model=${routing.resolved} account=${info.accountEmail ?? '-'} status=${info.status} ${info.durationMs}ms bytes=${info.contentBytes} tools=${info.toolCalls}${info.error ? ` err=${info.error}` : ''}`,
    );
  };

  const maxAttempts = Math.max(1, cfg.RETRY_MAX_ATTEMPTS);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let account: Account | undefined;
    try {
      account = accountManager.acquire();
    } catch (err) {
      if (err instanceof NoAccountAvailableError) {
        const status = err.reason === 'all-cooldown' ? 429 : 503;
        if (err.retryAfterMs) c.header('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
        return respondError(status, err.message, routing.resolved);
      }
      throw err;
    }

    let events: AsyncGenerator<QwenStreamEvent>;
    try {
      const session = await getSession(account);
      const gen = getProvider().streamChat(session, params);
      const first = await gen.next();
      if (first.done) throw new QwenError('upstream stream ended immediately', { status: 502 });
      let firstEvent = first.value;

      if (firstEvent.type === 'error' && firstEvent.error.authFailed) {
        // one forced re-login attempt on the same account
        try {
          const recovered = await recoverFromAuthFailure(account, firstEvent.error);
          const gen2 = getProvider().streamChat(recovered, params);
          const first2 = await gen2.next();
          if (!first2.done) firstEvent = first2.value;
          if (!first2.done && firstEvent.type !== 'error') {
            events = compose(firstEvent, gen2);
            return dispatch(events);
          }
        } catch (recErr) {
          log.warn(`re-login recovery failed for ${account.email}: ${String(recErr)}`);
        }
      }
      if (firstEvent.type === 'error') {
        const qerr = firstEvent.error;
        accountManager.reportError(account.id, qerr);
        modelHealth.recordError(routing.resolved, qerr.message, qerr.rateLimited);
        lastError = qerr;
        log.warn(`attempt ${attempt}/${maxAttempts} failed on ${account.email}: ${qerr.message}`);
        continue;
      }
      events = compose(firstEvent, gen);
    } catch (err) {
      const qerr = err instanceof QwenError ? err : new QwenError(String(err), { status: 0 });
      accountManager.reportError(account.id, qerr);
      modelHealth.recordError(routing.resolved, qerr.message, qerr.rateLimited);
      lastError = qerr;
      log.warn(`attempt ${attempt}/${maxAttempts} failed on ${account.email}: ${qerr.message}`);
      continue;
    }

    // ── committed to this account from here on ──
    function dispatch(ev: AsyncGenerator<QwenStreamEvent>): Response | Promise<Response> {
      if (!streaming) {
        return (async () => {
          try {
            const collected = await collectCompletion(ev, { meta, toolNames, cfg, signal: c.req.raw.signal });
            record({
              status: 200,
              usage: collected.usage,
              error: null,
              durationMs: Date.now() - startedAt,
              stream: false,
              accountId: account!.id,
              accountEmail: account!.email,
              toolCalls: collected.toolCalls.length,
              contentBytes: collected.content.length,
            });
            const payload = hooks.buildBody
              ? hooks.buildBody(collected, meta)
              : buildCompletionObject(meta, collected);
            return c.json(payload);
          } catch (err) {
            const qerr =
              err instanceof EarlyStreamError
                ? new QwenError(err.message, {
                    status: err.status,
                    rateLimited: err.rateLimited,
                    authFailed: err.authFailed,
                  })
                : new QwenError(String(err), { status: 500 });
            accountManager.reportError(account!.id, qerr);
            return respondError(qerr.status >= 400 ? qerr.status : 502, qerr.message, routing.resolved);
          }
        })();
      }
      return startStreaming({
        meta,
        events: ev,
        toolNames,
        cfg,
        signal: c.req.raw.signal,
        emitter: hooks.emitter,
        headers: extraHeaders,
        onFinish: (result: StreamResult) => {
          record({
            status: result.error && !result.content ? 502 : 200,
            usage: result.usage,
            error: result.error,
            durationMs: result.durationMs,
            stream: true,
            accountId: account!.id,
            accountEmail: account!.email,
            toolCalls: result.toolCalls.length,
            contentBytes: result.content.length,
          });
        },
      });
    }
    return dispatch(events);
  }

  const message = lastError?.message ?? 'All attempts failed';
  const status = lastError instanceof QwenError && lastError.rateLimited ? 429 : 502;
  return respondError(
    status,
    `Upstream request failed after ${maxAttempts} attempt(s): ${message}`,
    routing.resolved,
  );
}

function compose(
  first: QwenStreamEvent,
  rest: AsyncGenerator<QwenStreamEvent>,
): AsyncGenerator<QwenStreamEvent> {
  return (async function* () {
    yield first;
    yield* rest;
  })();
}

function fail(
  c: Context,
  status: number,
  message: string,
  startedAt: number,
  model: string,
  route = '/v1/chat/completions',
  hooks: ChatPipelineHooks = {},
): Response {
  monitorStore.record({
    ts: Date.now(),
    model: model || 'unknown',
    accountId: null,
    durationMs: Date.now() - startedAt,
    ok: false,
    status,
    totalTokens: null,
  });
  logStore.add({
    route,
    model: model || 'unknown',
    accountId: null,
    accountEmail: null,
    durationMs: Date.now() - startedAt,
    status,
    stream: false,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    error: message,
    clientIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });
  const payload =
    hooks.buildError?.(status, message) ??
    ({ error: { message, type: status === 400 ? 'invalid_request_error' : 'api_error' } } as const);
  return c.json(payload, status as any);
}
