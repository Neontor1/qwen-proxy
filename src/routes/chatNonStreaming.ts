/**
 * Non-streaming responder: drains provider events through the same
 * filter+tool pipeline and returns a complete OpenAI chat.completion object.
 */
import type { AppConfig } from '../services/configService.js';
import { createContentFilter } from '../services/contentFilter.js';
import type { QwenStreamEvent } from '../services/qwen.js';
import { ToolGuard } from '../tools/guard.js';
import { type ParsedToolCall, StreamingToolParser } from '../tools/xmlToolParser.js';
import { createLogger } from '../utils/logger.js';
import { type ChunkMeta, mapUsage } from './chunkBuilders.js';

const log = createLogger('nonstream');

/** Thrown when the upstream fails before any content arrived → caller may failover. */
export class EarlyStreamError extends Error {
  status: number;
  rateLimited: boolean;
  authFailed: boolean;
  constructor(message: string, status = 502, rateLimited = false, authFailed = false) {
    super(message);
    this.name = 'EarlyStreamError';
    this.status = status;
    this.rateLimited = rateLimited;
    this.authFailed = authFailed;
  }
}

export interface CollectedCompletion {
  content: string;
  reasoning: string;
  toolCalls: ParsedToolCall[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  finishReason: string;
  durationMs: number;
}

export async function collectCompletion(
  events: AsyncGenerator<QwenStreamEvent>,
  opts: { meta: ChunkMeta; toolNames: string[]; cfg: AppConfig; signal?: AbortSignal },
): Promise<CollectedCompletion> {
  const started = Date.now();
  const filter = createContentFilter(opts.cfg.CLEAN_OUTPUT);
  const parser = new StreamingToolParser(opts.toolNames);
  const guard = new ToolGuard();

  let content = '';
  let reasoning = '';
  const toolCalls: ParsedToolCall[] = [];
  let usage: CollectedCompletion['usage'] = null;
  let finishReason = 'stop';

  const consume = (text: string, calls: ParsedToolCall[]) => {
    if (text) {
      const cleaned = filter.push(text);
      if (cleaned) content += cleaned;
    }
    for (const call of calls) {
      if (!guard.allow(call).allow) continue;
      toolCalls.push(call);
    }
  };

  for await (const event of events) {
    if (opts.signal?.aborted) throw new EarlyStreamError('client aborted', 499);
    switch (event.type) {
      case 'delta': {
        const step = parser.push(event.text);
        consume(step.text, step.calls);
        break;
      }
      case 'reasoning':
        reasoning += event.text;
        break;
      case 'usage':
        usage = mapUsage(event.usage);
        break;
      case 'finish':
        finishReason = event.reason || 'stop';
        break;
      case 'error': {
        const err = event.error;
        log.warn(`upstream error in non-streaming collect: ${err.message}`);
        if (!content && !toolCalls.length) {
          throw new EarlyStreamError(err.message, err.status, err.rateLimited, err.authFailed);
        }
        // partial content already collected → return what we have
        finishReason = 'stop';
        break;
      }
    }
  }

  const fin = parser.flush();
  consume(fin.text, fin.calls);
  const tail = filter.flush();
  if (tail) content += tail;
  if (toolCalls.length && finishReason === 'stop') finishReason = 'tool_calls';

  return { content, reasoning, toolCalls, usage, finishReason, durationMs: Date.now() - started };
}

export function buildCompletionObject(meta: ChunkMeta, collected: CollectedCompletion): object {
  const message: Record<string, unknown> = { role: 'assistant', content: collected.content };
  if (collected.reasoning) message.reasoning_content = collected.reasoning;
  if (collected.toolCalls.length) {
    message.tool_calls = collected.toolCalls.map((call, i) => ({
      id: call.id,
      type: 'function',
      index: i,
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, message, finish_reason: collected.finishReason }],
    usage: collected.usage ?? {
      prompt_tokens: 0,
      completion_tokens: Math.ceil(collected.content.length / 4),
      total_tokens: Math.ceil(collected.content.length / 4),
    },
  };
}
