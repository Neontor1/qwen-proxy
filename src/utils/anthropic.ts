/**
 * Anthropic Messages API ⇄ OpenAI Chat Completions conversion.
 *
 * Claude Code (and other Anthropic clients) talk to `POST {ANTHROPIC_BASE_URL}/messages`
 * using Anthropic's wire format: `system` is a top-level field, content is an
 * array of typed blocks, tools use `input_schema`, tool calls come back as
 * `tool_use` blocks and streaming uses named SSE events.
 *
 * Everything here is pure (no I/O, no singletons) so it is trivially testable:
 * the gateway translates the request into the OpenAI shape, runs the regular
 * chat pipeline, then translates the result back.
 */
import { randomBytes } from 'node:crypto';
import type { CollectedCompletion } from '../routes/chatNonStreaming.js';
import type { ChunkEmitter, SseEvent, StreamUsage } from '../routes/chatStreaming.js';
import type { ParsedToolCall } from '../tools/xmlToolParser.js';
import { estimateMessagesTokens, estimateTokens } from './tokenEstimator.js';

/** Anthropic message id (`msg_…`). */
export function anthropicMessageId(): string {
  return `msg_${randomBytes(18).toString('hex')}`;
}

// ── request → OpenAI ────────────────────────────────────────────────────────

interface AnthropicBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number | null;
  system?: string | AnthropicBlock[] | null;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type?: string; name?: string } | null;
  thinking?: { type?: string; budget_tokens?: number } | null;
}

function blocksOf(content: string | AnthropicBlock[] | null | undefined): AnthropicBlock[] {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

function textOf(content: string | AnthropicBlock[] | null | undefined): string {
  return blocksOf(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n');
}

function blockContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as AnthropicBlock).text === 'string') {
          return (part as AnthropicBlock).text as string;
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

/** `image` block → OpenAI `image_url` part (base64 data URI or plain url). */
function imagePart(block: AnthropicBlock): Record<string, unknown> | null {
  const src = block.source;
  if (!src) return null;
  const url =
    src.type === 'base64' && src.data
      ? `data:${src.media_type ?? 'image/png'};base64,${src.data}`
      : (src.url ?? '');
  if (!url) return null;
  return { type: 'image_url', image_url: { url } };
}

/**
 * Convert an Anthropic Messages request into an OpenAI Chat Completions body.
 * Handles: top-level `system`, text/image/tool_use/tool_result blocks,
 * `input_schema` tools, Anthropic `tool_choice`, `stop_sequences`, `thinking`.
 */
export function anthropicRequestToOpenAI(req: AnthropicRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  const systemText = textOf(req.system as string | AnthropicBlock[] | null);
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const msg of req.messages ?? []) {
    const blocks = blocksOf(msg.content);
    const toolResults: Record<string, unknown>[] = [];
    const toolUses: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
    const textParts: Array<string | Record<string, unknown>> = [];

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text) textParts.push(block.text);
          break;
        case 'image': {
          const part = imagePart(block);
          if (part) textParts.push(part);
          break;
        }
        case 'tool_use':
          if (block.name) {
            toolUses.push({
              id: block.id || `call_${randomBytes(9).toString('hex')}`,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
          break;
        case 'tool_result':
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? '',
            content: blockContentToString(block.content),
            ...(block.is_error ? { name: 'error' } : {}),
          });
          break;
        case 'thinking':
        case 'redacted_thinking':
          // Reasoning is regenerated per turn; forwarding it adds noise.
          break;
        default:
          if (typeof block.text === 'string' && block.text) textParts.push(block.text);
          break;
      }
    }

    // assistant tool calls must precede the tool results that answer them
    if (msg.role === 'assistant' && toolUses.length) {
      messages.push({
        role: 'assistant',
        content: textParts.length ? textParts.filter((p) => typeof p === 'string').join('\n\n') : '',
        tool_calls: toolUses,
      });
    } else if (textParts.length) {
      const needsParts = textParts.some((p) => typeof p !== 'string');
      messages.push({
        role: msg.role,
        content: needsParts ? textParts : (textParts.join('\n\n') as string),
      });
    }
    messages.push(...toolResults);
  }

  const out: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: !!req.stream,
  };
  if (typeof req.max_tokens === 'number' && req.max_tokens > 0) out.max_tokens = req.max_tokens;
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;

  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
    const choice = req.tool_choice?.type;
    if (choice === 'auto') out.tool_choice = 'auto';
    else if (choice === 'any') out.tool_choice = 'required';
    else if (choice === 'none') out.tool_choice = 'none';
    else if (choice === 'tool' && req.tool_choice?.name) {
      out.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
    }
  }

  // Anthropic "thinking" → Qwen thinking; anything else keeps the gateway default.
  if (req.thinking?.type === 'enabled') out.thinking = true;
  else if (req.thinking?.type === 'disabled') out.thinking = false;

  return out;
}

// ── OpenAI → Anthropic response ─────────────────────────────────────────────

/** OpenAI `finish_reason` → Anthropic `stop_reason`. */
export function toStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'end_turn';
    case 'abort':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

/** Rough Anthropic-style usage from OpenAI-style usage. */
export function toAnthropicUsage(
  usage: StreamUsage | CollectedCompletion['usage'],
  fallbackText = '',
): { input_tokens: number; output_tokens: number } {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens || Math.max(1, estimateTokens(fallbackText));
  return { input_tokens: input, output_tokens: output };
}

export interface AnthropicResponseOptions {
  /** Model id echoed back to the client (Anthropic echoes what was requested). */
  model: string;
  /** Emit `thinking` blocks for model reasoning (only when the client asked). */
  thinking?: boolean;
  messageId?: string;
}

/** Build the non-streaming Anthropic `message` object from a collected completion. */
export function anthropicMessageObject(
  collected: CollectedCompletion,
  opts: AnthropicResponseOptions,
): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (opts.thinking && collected.reasoning) {
    content.push({ type: 'thinking', thinking: collected.reasoning, signature: '' });
  }
  if (collected.content) content.push({ type: 'text', text: collected.content });
  for (const call of collected.toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: parseArguments(call.arguments),
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: opts.messageId ?? anthropicMessageId(),
    type: 'message',
    role: 'assistant',
    model: opts.model,
    content,
    stop_reason: collected.toolCalls.length ? 'tool_use' : toStopReason(collected.finishReason),
    stop_sequence: null,
    usage: toAnthropicUsage(collected.usage, collected.content),
  };
}

/** Anthropic error envelope with the status-appropriate error type. */
export function anthropicErrorBody(status: number, message: string): Record<string, unknown> {
  const type =
    status === 400
      ? 'invalid_request_error'
      : status === 401
        ? 'authentication_error'
        : status === 403
          ? 'permission_error'
          : status === 404
            ? 'not_found_error'
            : status === 413
              ? 'request_too_large'
              : status === 429
                ? 'rate_limit_error'
                : status >= 500 && status < 600
                  ? 'api_error'
                  : 'invalid_request_error';
  return { type: 'error', error: { type, message } };
}

// ── streaming emitter ───────────────────────────────────────────────────────

export interface AnthropicEmitterOptions {
  model: string;
  messageId: string;
  inputTokens: number;
  /** Emit reasoning as `thinking` blocks (client requested extended thinking). */
  thinking?: boolean;
}

type OpenBlock = 'text' | 'thinking' | 'tool';

/**
 * Stateful emitter producing Anthropic SSE events:
 * `message_start` → `content_block_start` → `content_block_delta`* →
 * `content_block_stop` → `message_delta` → `message_stop`.
 */
export function createAnthropicEmitter(opts: AnthropicEmitterOptions): ChunkEmitter {
  let nextIndex = 0;
  let open: OpenBlock | null = null;
  let openIndex = -1;
  let outputChars = 0;

  const ev = (event: string, data: object): SseEvent => ({ event, data: { type: event, ...data } });

  const closeBlock = (): SseEvent[] => {
    if (open === null) return [];
    const frame = ev('content_block_stop', { index: openIndex });
    open = null;
    openIndex = -1;
    return [frame];
  };

  const openBlock = (kind: OpenBlock, block: object): SseEvent[] => {
    openIndex = nextIndex++;
    open = kind;
    return [ev('content_block_start', { index: openIndex, content_block: block })];
  };

  return {
    begin: () => [
      ev('message_start', {
        message: {
          id: opts.messageId,
          type: 'message',
          role: 'assistant',
          model: opts.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: opts.inputTokens, output_tokens: 0 },
        },
      }),
      ev('ping', {}),
    ],
    text: (_meta: never, text: string) => {
      outputChars += text.length;
      const frames: SseEvent[] = [];
      if (open !== 'text') {
        frames.push(...closeBlock(), ...openBlock('text', { type: 'text', text: '' }));
      }
      frames.push(ev('content_block_delta', { index: openIndex, delta: { type: 'text_delta', text } }));
      return frames;
    },
    reasoning: (_meta: never, text: string) => {
      if (!opts.thinking) return [];
      outputChars += text.length;
      const frames: SseEvent[] = [];
      if (open !== 'thinking') {
        frames.push(...closeBlock(), ...openBlock('thinking', { type: 'thinking', thinking: '' }));
      }
      frames.push(
        ev('content_block_delta', { index: openIndex, delta: { type: 'thinking_delta', thinking: text } }),
      );
      return frames;
    },
    toolCall: (_meta: never, call: ParsedToolCall) => {
      const frames: SseEvent[] = [...closeBlock()];
      frames.push(...openBlock('tool', { type: 'tool_use', id: call.id, name: call.name, input: {} }));
      outputChars += call.arguments.length;
      frames.push(
        ev('content_block_delta', {
          index: openIndex,
          delta: { type: 'input_json_delta', partial_json: call.arguments || '{}' },
        }),
      );
      return frames;
    },
    finish: (_meta: never, finishReason: string | null, usage: StreamUsage | null) => {
      const frames: SseEvent[] = [];
      if (open === null && nextIndex === 0) {
        // Anthropic always sends at least one content block
        frames.push(...openBlock('text', { type: 'text', text: '' }));
      }
      frames.push(...closeBlock());
      frames.push(
        ev('message_delta', {
          delta: {
            stop_reason: finishReason === 'tool_calls' ? 'tool_use' : toStopReason(finishReason),
            stop_sequence: null,
          },
          usage: { output_tokens: usage?.completion_tokens || Math.max(1, Math.ceil(outputChars / 4)) },
        }),
      );
      frames.push(ev('message_stop', {}));
      return frames;
    },
    terminateWithDone: false,
  };
}

/** `POST /v1/messages/count_tokens` — cheap local estimate (no upstream call). */
export function countAnthropicTokens(body: {
  system?: string | AnthropicBlock[] | null;
  messages?: AnthropicMessage[];
  tools?: unknown[];
}): { input_tokens: number } {
  const openai = anthropicRequestToOpenAI({
    model: 'qwen3-max',
    messages: body.messages ?? [],
    system: body.system,
  });
  let tokens = estimateMessagesTokens(openai.messages as Array<{ role?: string; content?: unknown }>);
  for (const tool of body.tools ?? []) tokens += estimateTokens(JSON.stringify(tool));
  return { input_tokens: Math.max(1, tokens) };
}
