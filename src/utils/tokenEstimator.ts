/**
 * Rough token estimator (no external tokenizer dependency).
 * Heuristic: CJK ≈ 1 token/char, other text ≈ 1 token per 4 chars,
 * plus a small per-message overhead like OpenAI's chat format.
 */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export interface ChatLikeMessage {
  role?: string;
  content?: unknown;
}

/** Estimate prompt tokens for an OpenAI-style messages array. */
export function estimateMessagesTokens(messages: ChatLikeMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message overhead
    total += estimateTokens(String(m.role ?? ''));
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
          total += estimateTokens((part as any).text);
        }
      }
    }
  }
  return total + 2; // reply priming
}
