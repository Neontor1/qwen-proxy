/**
 * Prompt renderer — converts an OpenAI-style messages array into the single
 * text prompt expected by the chat.qwen.ai web API (each proxy request opens
 * a fresh upstream chat, so history must be embedded into the prompt).
 *
 * Also injects a tool-calling instruction block when `tools` are provided,
 * asking the model to answer with a <tool_response> XML envelope that
 * tools/xmlToolParser.ts understands.
 */
import type { ToolDefinition } from './qwen.js';

export interface RenderableMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export function contentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          if (p.type === 'image_url') return '[image attached]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

const TOOL_INSTRUCTION_HEADER = '## Available Tools';

export function renderToolInstructions(tools: ToolDefinition[]): string {
  const lines: string[] = [TOOL_INSTRUCTION_HEADER, ''];
  for (const t of tools) {
    const name = t.function?.name ?? t.name ?? 'unknown';
    const desc = t.function?.description ?? t.description ?? '';
    const params = t.function?.parameters ?? t.parameters;
    lines.push(`- ${name}${desc ? `: ${desc}` : ''}`);
    if (params) lines.push(`  Parameters (JSON Schema): ${JSON.stringify(params)}`);
  }
  lines.push(
    '',
    'To call a tool, respond with ONLY this exact XML envelope (no markdown fences):',
    '<tool_response>',
    '{"name": "<tool_name>", "arguments": { ... }}',
    '</tool_response>',
    'After receiving the tool result, continue the conversation normally.',
  );
  return lines.join('\n');
}

export function renderPrompt(messages: RenderableMessage[], tools?: ToolDefinition[]): string {
  const parts: string[] = [];

  const systemMsgs = messages.filter((m) => m.role === 'system' || m.role === 'developer');
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');

  const systemText = systemMsgs
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join('\n\n');
  if (systemText) parts.push(`[System Instructions]\n${systemText}`);
  if (tools?.length) parts.push(renderToolInstructions(tools));

  if (convo.length === 0) {
    parts.push('[Current Request]\n(continue)');
  } else if (convo.length === 1) {
    parts.push(`[Current Request]\n${contentToText(convo[0]!.content)}`);
  } else {
    parts.push('[Conversation History]');
    for (const m of convo.slice(0, -1)) {
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const calls = m.tool_calls
          .map((c) => `${c.function?.name ?? 'tool'}(${c.function?.arguments ?? ''})`)
          .join(', ');
        parts.push(`assistant: [called tools: ${calls}]`);
        const text = contentToText(m.content);
        if (text) parts.push(`assistant: ${text}`);
      } else if (m.role === 'tool') {
        parts.push(`tool result${m.name ? ` (${m.name})` : ''}: ${contentToText(m.content)}`);
      } else {
        parts.push(`${m.role}: ${contentToText(m.content)}`);
      }
    }
    const last = convo[convo.length - 1]!;
    parts.push('');
    if (last.role === 'tool') {
      parts.push(
        `[Current Request]\ntool result${last.name ? ` (${last.name})` : ''}: ${contentToText(last.content)}`,
      );
    } else {
      parts.push(`[Current Request]\n${contentToText(last.content)}`);
    }
  }

  return parts.join('\n\n');
}
