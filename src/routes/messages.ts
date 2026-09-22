/**
 * POST /v1/messages — Anthropic Messages API compatibility layer.
 *
 * Claude Code, the Claude Agent SDK and other Anthropic clients point
 * `ANTHROPIC_BASE_URL` at the gateway and speak Anthropic's wire format. This
 * route translates the request into the OpenAI shape, runs the *same* pipeline
 * as `/v1/chat/completions` (account rotation, failover, content filter, tool
 * parsing, metrics, logs) and translates the result back — including the named
 * SSE events used by Anthropic streaming.
 *
 * Also implements `POST /v1/messages/count_tokens` (local estimate) which
 * Claude Code calls before sending a prompt.
 */
import type { Context } from 'hono';
import {
  type AnthropicRequest,
  anthropicErrorBody,
  anthropicMessageId,
  anthropicMessageObject,
  anthropicRequestToOpenAI,
  countAnthropicTokens,
  createAnthropicEmitter,
} from '../utils/anthropic.js';
import { createLogger } from '../utils/logger.js';
import { estimateMessagesTokens } from '../utils/tokenEstimator.js';
import { runChatCompletion } from './chat.js';
import { anthropicCountTokensSchema, anthropicMessagesSchema } from './schemas.js';

const log = createLogger('anthropic');

function badRequest(c: Context, message: string): Response {
  return c.json(anthropicErrorBody(400, message), 400);
}

export async function handleAnthropicMessages(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badRequest(c, 'Request body must be valid JSON');
  }

  const parsed = anthropicMessagesSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return badRequest(c, msg);
  }
  const req = parsed.data as unknown as AnthropicRequest;

  const openAiBody = anthropicRequestToOpenAI(req);
  const messageId = anthropicMessageId();
  const inputTokens = estimateMessagesTokens(
    openAiBody.messages as Array<{ role?: string; content?: unknown }>,
  );
  const thinking = req.thinking?.type === 'enabled';
  const toolCount = req.tools?.length ?? 0;

  log.info(
    `messages request: model=${req.model} messages=${req.messages?.length ?? 0} tools=${toolCount} stream=${!!req.stream} thinking=${thinking}`,
  );

  return runChatCompletion(
    c,
    {
      route: '/v1/messages',
      buildBody: (collected) => anthropicMessageObject(collected, { model: req.model, thinking, messageId }),
      emitter: createAnthropicEmitter({ model: req.model, messageId, inputTokens, thinking }),
      buildError: (status, message) => anthropicErrorBody(status, message),
    },
    openAiBody,
  );
}

export async function handleAnthropicCountTokens(c: Context): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badRequest(c, 'Request body must be valid JSON');
  }
  const parsed = anthropicCountTokensSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return badRequest(c, msg);
  }
  return c.json(countAnthropicTokens(parsed.data));
}
