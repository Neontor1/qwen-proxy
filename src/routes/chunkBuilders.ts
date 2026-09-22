/**
 * OpenAI chunk builders shared by streaming and non-streaming responders.
 */
import type { ParsedToolCall } from '../tools/xmlToolParser.js';

export interface ChunkMeta {
  id: string;
  created: number;
  model: string;
}

export function roleChunk(meta: ChunkMeta): object {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  };
}

export function contentChunk(meta: ChunkMeta, text: string): object {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

export function reasoningChunk(meta: ChunkMeta, text: string): object {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  };
}

/** Emits one tool call as a single delta (id+name+full arguments JSON). */
export function toolCallChunk(meta: ChunkMeta, call: ParsedToolCall, index: number): object {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function finishChunk(
  meta: ChunkMeta,
  finishReason: string | null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null,
): object {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function mapUsage(
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null | undefined,
) {
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage?.total_tokens ?? prompt + completion,
  };
}
