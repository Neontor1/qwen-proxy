/**
 * Zod schemas for public API requests.
 */
import { z } from 'zod';

const contentPart = z.union([
  z.string(),
  z.array(
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
        image_url: z.unknown().optional(),
      })
      .passthrough(),
  ),
]);

export const messageSchema = z.object({
  role: z.string(),
  content: contentPart.nullish(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z
        .object({
          id: z.string().optional(),
          type: z.string().optional(),
          function: z
            .object({ name: z.string().optional(), arguments: z.string().optional() })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    )
    .optional(),
});

export const toolSchema = z
  .object({
    type: z.string().optional(),
    function: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  })
  .passthrough();

export const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.unknown().optional(),
  user: z.string().optional(),
  /** Qwen extensions */
  enable_search: z.boolean().optional(),
  thinking: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

// ── Anthropic Messages API (Claude Code & other Anthropic clients) ──────────
const anthropicContentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
    source: z
      .object({
        type: z.string().optional(),
        media_type: z.string().optional(),
        data: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(anthropicContentBlock)]),
});

export const anthropicMessagesSchema = z.object({
  model: z.string().min(1),
  messages: z.array(anthropicMessageSchema).min(1),
  /** Anthropic requires max_tokens; tolerate its absence. */
  max_tokens: z.number().int().positive().nullish(),
  system: z.union([z.string(), z.array(anthropicContentBlock)]).nullish(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z
    .array(
      z
        .object({
          name: z.string(),
          description: z.string().optional(),
          input_schema: z.unknown().optional(),
        })
        .passthrough(),
    )
    .optional(),
  tool_choice: z
    .object({
      type: z.string(),
      name: z.string().optional(),
      disable_parallel_tool_use: z.boolean().optional(),
    })
    .passthrough()
    .nullish(),
  thinking: z.object({ type: z.string(), budget_tokens: z.number().optional() }).passthrough().nullish(),
  metadata: z.unknown().optional(),
});

export type AnthropicMessagesRequest = z.infer<typeof anthropicMessagesSchema>;

export const anthropicCountTokensSchema = z.object({
  model: z.string().optional(),
  system: z.union([z.string(), z.array(anthropicContentBlock)]).nullish(),
  messages: z.array(anthropicMessageSchema).min(1),
  tools: z.array(z.unknown()).optional(),
});

export const addAccountSchema = z.object({
  /** login / display identity; optional for cookie accounts (synthesised when absent) */
  email: z.string().min(3).optional(),
  password: z.string().min(1).optional(),
  /** raw `Cookie:` header / Cookie-Editor export — creates a cookie account */
  cookies: z.string().min(1).optional(),
  label: z.string().max(120).optional(),
});

export const verifyCookiesSchema = z.object({
  cookies: z.string().min(1),
});

export function openAiError(message: string, type = 'invalid_request_error', code?: string, status = 400) {
  return { status, body: { error: { message, type, ...(code ? { code } : {}) } } };
}
