/**
 * SSE streaming responder: consumes provider events, runs the content-filter
 * + tool-parser pipeline and emits client-facing events with heartbeat, idle
 * timeout and graceful termination.
 *
 * The wire dialect is pluggable through `ChunkEmitter`:
 *   - `openAiEmitter` (default)  → `chat.completion.chunk` objects + `data: [DONE]`
 *   - the Anthropic emitter      → named `message_start` / `content_block_*` /
 *                                  `message_delta` / `message_stop` events
 * Everything else (filtering, tool parsing, guards, failover, metrics) is shared.
 */
import type { AppConfig } from '../services/configService.js';
import { createContentFilter } from '../services/contentFilter.js';
import type { QwenStreamEvent } from '../services/qwen.js';
import { ToolGuard } from '../tools/guard.js';
import { type ParsedToolCall, StreamingToolParser } from '../tools/xmlToolParser.js';
import { createLogger } from '../utils/logger.js';
import { type SseChannel, createSseChannel, sseHeaders } from '../utils/streaming.js';
import {
  type ChunkMeta,
  contentChunk,
  finishChunk,
  mapUsage,
  reasoningChunk,
  roleChunk,
  toolCallChunk,
} from './chunkBuilders.js';

const log = createLogger('stream');

export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** One SSE frame: optional event name + JSON payload. */
export interface SseEvent {
  event?: string;
  data: object;
}

/**
 * Translates pipeline output into wire events. Implementations may be stateful
 * (Anthropic tracks open content blocks), so create one per request.
 */
export interface ChunkEmitter {
  /** Frames sent before the first upstream event. */
  begin(meta: ChunkMeta): SseEvent[];
  /** A cleaned piece of assistant text. */
  text(meta: ChunkMeta, text: string): SseEvent[];
  /** Model reasoning (think tags) — may be dropped by the dialect. */
  reasoning(meta: ChunkMeta, text: string): SseEvent[];
  /** A parsed tool call; `index` is 0-based within the response. */
  toolCall(meta: ChunkMeta, call: ParsedToolCall, index: number): SseEvent[];
  /** Final frames (finish reason + usage). */
  finish(meta: ChunkMeta, finishReason: string | null, usage: StreamUsage | null): SseEvent[];
  /** OpenAI ends the stream with `data: [DONE]`; Anthropic simply closes it. */
  readonly terminateWithDone: boolean;
}

/** Default dialect: OpenAI `chat.completion.chunk`. */
export const openAiEmitter: ChunkEmitter = {
  begin: (meta) => [{ data: roleChunk(meta) }],
  text: (meta, text) => [{ data: contentChunk(meta, text) }],
  reasoning: (meta, text) => [{ data: reasoningChunk(meta, text) }],
  toolCall: (meta, call, index) => [{ data: toolCallChunk(meta, call, index) }],
  finish: (meta, reason, usage) => [{ data: finishChunk(meta, reason, usage) }],
  terminateWithDone: true,
};

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ParsedToolCall[];
  suppressedCalls: string[];
  usage: StreamUsage | null;
  finishReason: string;
  durationMs: number;
  error: string | null;
  aborted: boolean;
}

export interface StreamOptions {
  meta: ChunkMeta;
  events: AsyncGenerator<QwenStreamEvent>;
  toolNames: string[];
  cfg: AppConfig;
  signal?: AbortSignal;
  onFinish: (result: StreamResult) => void;
  /** Wire dialect; defaults to OpenAI-compatible chunks. */
  emitter?: ChunkEmitter;
  /** Extra response headers (e.g. `X-Model-Routed-From`). */
  headers?: Record<string, string>;
}

export function startStreaming(opts: StreamOptions): Response {
  const emitter = opts.emitter ?? openAiEmitter;
  const channel = createSseChannel({
    heartbeatMs: opts.cfg.HEARTBEAT_INTERVAL_MS,
    heartbeatText: 'keep-alive',
  });

  void pump(channel, opts, emitter);

  return new Response(channel.readable, {
    status: 200,
    headers: { ...sseHeaders(), ...(opts.headers ?? {}) },
  });
}

async function pump(channel: SseChannel, opts: StreamOptions, emitter: ChunkEmitter): Promise<void> {
  const started = Date.now();
  const result: StreamResult = {
    content: '',
    reasoning: '',
    toolCalls: [],
    suppressedCalls: [],
    usage: null,
    finishReason: 'stop',
    durationMs: 0,
    error: null,
    aborted: false,
  };

  const filter = createContentFilter(opts.cfg.CLEAN_OUTPUT);
  const parser = new StreamingToolParser(opts.toolNames);
  const guard = new ToolGuard();

  const emit = (events: SseEvent[]) => {
    for (const e of events) channel.send(e.data, e.event);
  };
  const terminate = () => {
    if (channel.closed) return;
    if (emitter.terminateWithDone) channel.done();
    else channel.close();
  };

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (channel.closed) return;
      result.error = `stream idle timeout (${opts.cfg.STREAM_IDLE_TIMEOUT_MS}ms without events)`;
      log.warn(result.error);
      channel.comment('stream closed: idle timeout');
      terminate();
    }, opts.cfg.STREAM_IDLE_TIMEOUT_MS);
    if (typeof idleTimer === 'object' && 'unref' in idleTimer) (idleTimer as NodeJS.Timeout).unref?.();
  };

  const onAbort = () => {
    result.aborted = true;
    result.finishReason = 'abort';
    channel.close();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const emitText = (raw: string) => {
    const step = parser.push(raw);
    emitStep(step.text, step.calls);
  };
  const emitStep = (text: string, calls: ParsedToolCall[]) => {
    if (text) {
      const cleaned = filter.push(text);
      if (cleaned) {
        result.content += cleaned;
        emit(emitter.text(opts.meta, cleaned));
      }
    }
    for (const call of calls) {
      const decision = guard.allow(call);
      if (!decision.allow) {
        result.suppressedCalls.push(decision.reason ?? 'suppressed');
        log.warn(`tool call suppressed: ${decision.reason}`);
        continue;
      }
      result.toolCalls.push(call);
      emit(emitter.toolCall(opts.meta, call, result.toolCalls.length - 1));
    }
  };

  emit(emitter.begin(opts.meta));
  armIdle();

  try {
    for await (const event of opts.events) {
      if (channel.closed) break;
      armIdle();
      switch (event.type) {
        case 'delta':
          emitText(event.text);
          break;
        case 'reasoning':
          result.reasoning += event.text;
          emit(emitter.reasoning(opts.meta, event.text));
          break;
        case 'usage':
          result.usage = mapUsage(event.usage);
          break;
        case 'finish':
          result.finishReason =
            event.reason === 'tool_calls' || result.toolCalls.length ? 'tool_calls' : event.reason || 'stop';
          break;
        case 'error':
          result.error = event.error.message;
          log.error(`mid-stream upstream error: ${event.error.message}`);
          break;
      }
      if (result.error) break;
    }

    // finalize pipeline
    if (!result.error || result.content) {
      const fin = parser.flush();
      emitStep(fin.text, fin.calls);
      const tail = filter.flush();
      if (tail) {
        result.content += tail;
        emit(emitter.text(opts.meta, tail));
      }
    }
    if (result.toolCalls.length && result.finishReason === 'stop') result.finishReason = 'tool_calls';
    emit(emitter.finish(opts.meta, result.finishReason, result.usage));
  } catch (err) {
    result.error = result.error ?? String(err);
    log.error(`stream pump failed: ${String(err)}`);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    opts.signal?.removeEventListener('abort', onAbort);
    result.durationMs = Date.now() - started;
    terminate();
    opts.onFinish(result);
  }
}
