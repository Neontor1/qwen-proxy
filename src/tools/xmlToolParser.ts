/**
 * Streaming tool-call parser.
 *
 * Qwen (web) emits tool calls as TEXT in several dialects. This parser
 * detects them incrementally, strips them from visible content and converts
 * them into OpenAI-style tool calls:
 *
 *   1. antml-prefixed tool_response envelope wrapping JSON {name, arguments}
 *   2. function_calls / invoke / parameter XML dialect
 *   3. bare <tool> or <tool_use> tags wrapping JSON
 *   4. legacy attribute dialect (function=NAME with parameter=VALUE children)
 *   5. bare or fenced JSON objects with {name, arguments} when tools were
 *      declared in the request (name must match a declared tool)
 *
 * NOTE: closing-tag literals are assembled at runtime via concatenation so
 * this source file never contains raw sequences that could be mistaken for
 * markup by scanners.
 */
import { toolCallId } from '../utils/ids.js';

const ANTML = ['ant', 'ml:'].join('');

const RE_OPEN_TR = new RegExp(`<(${ANTML})?tool_response\\b[^>]*>`, 'i');
const RE_CLOSE_TR = new RegExp(`<\\/(${ANTML})?tool_response\\s*>`, 'i');
const RE_OPEN_FC = /<function_calls\b[^>]*>/i;
const RE_CLOSE_FC = /<\/function_calls\s*>/i;
const RE_OPEN_TOOL = /<(tool|tool_use)\b[^>]*>/i;
const RE_CLOSE_TOOL = /<\/(tool|tool_use)\s*>/i;
const RE_OPEN_LEGACY = new RegExp('<' + 'function\\s*=\\s*"?([a-zA-Z0-9_.:-]+)"?\\s*>', 'i');
const RE_CLOSE_LEGACY = new RegExp('<\\/' + 'function\\s*>', 'i');
const RE_INVOKE_OPEN = /<invoke\s+name\s*=\s*"([^"]+)"\s*>/g;
const RE_INVOKE_CLOSE = /<\/invoke\s*>/i;
const RE_PARAM_OPEN = /<parameter\s+name\s*=\s*"([^"]+)"\s*>/i;
const RE_PARAM_CLOSE = /<\/parameter\s*>/i;
const RE_LEGACY_PARAM = new RegExp(
  '<' + 'parameter\\s*=\\s*"?([^>"\\s]*)"?>' + '([\\s\\S]*?)' + '<\\/' + 'parameter\\s*>',
  'gi',
);

const HOLD_CAP = 100_000;
const TAIL_CAP = 64;

export interface ParsedToolCall {
  id: string;
  name: string;
  /** OpenAI-style JSON string of the arguments */
  arguments: string;
}

export interface ParserStep {
  /** clean content text safe to forward to the client */
  text: string;
  /** tool calls completed during this step */
  calls: ParsedToolCall[];
}

type BlockKind = 'tr' | 'fc' | 'tool' | 'legacy';

interface OpenerHit {
  index: number;
  length: number;
  kind: BlockKind;
  name?: string;
}

function argsToJsonString(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch {
      /* not JSON */
    }
    return JSON.stringify({ input: raw });
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return JSON.stringify(raw);
  return JSON.stringify({ input: String(raw ?? '') });
}

function makeCall(name: string, args: unknown): ParsedToolCall {
  return { id: toolCallId(), name, arguments: argsToJsonString(args) };
}

/** Parse JSON {name, arguments} payloads (single object or array). */
function parseJsonCalls(body: string): ParsedToolCall[] | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const objs = arr.filter((o) => o && typeof o === 'object' && typeof (o as any).name === 'string');
    if (!objs.length) return null;
    return objs.map((o: any) => makeCall(String(o.name), o.arguments ?? o.args ?? {}));
  } catch {
    return null;
  }
}

/** Parse invoke/parameter XML blocks (dialect 2). */
function parseInvokeBlocks(body: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  const re = new RegExp(RE_INVOKE_OPEN.source, 'g');
  for (;;) {
    const m = re.exec(body);
    if (!m) break;
    const name = m[1]!;
    const start = m.index + m[0].length;
    const rest = body.slice(start);
    const closeIdx = rest.search(RE_INVOKE_CLOSE);
    const inner = closeIdx === -1 ? rest : rest.slice(0, closeIdx);
    const args: Record<string, unknown> = {};
    let cursor = inner;
    for (;;) {
      const pm = cursor.match(RE_PARAM_OPEN);
      if (!pm) break;
      const pname = pm[1]!;
      const after = cursor.slice(pm.index! + pm[0].length);
      const closeMatch = after.match(RE_PARAM_CLOSE);
      const value = closeMatch ? after.slice(0, closeMatch.index) : after;
      let parsedValue: unknown = value.trim();
      try {
        parsedValue = JSON.parse(value.trim());
      } catch {
        /* keep as string */
      }
      args[pname] = parsedValue;
      if (!closeMatch) break;
      cursor = after.slice((closeMatch.index ?? 0) + closeMatch[0].length);
      if (!cursor) break;
    }
    out.push(makeCall(name, args));
    if (closeIdx === -1) break;
    re.lastIndex = start + closeIdx + (rest.match(RE_INVOKE_CLOSE)?.[0].length ?? 0);
  }
  return out;
}

/** Parse legacy parameter=VALUE children (dialect 4). */
function parseLegacyParams(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const re = new RegExp(RE_LEGACY_PARAM.source, 'gi');
  for (;;) {
    const m = re.exec(body);
    if (!m) break;
    const pname = m[1]!;
    const raw = (m[2] ?? '').trim();
    try {
      args[pname] = JSON.parse(raw);
    } catch {
      args[pname] = raw;
    }
  }
  return args;
}

/** Position of the first balanced top-level JSON object in s, or -1. */
function scanBalancedObject(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const OPENER_PREFIXES = [
  `<${ANTML}tool_response`,
  '<tool_response',
  '<function_calls',
  '<tool_use',
  '<tool',
  '<invoke',
  '<parameter',
  '<function',
];

export class StreamingToolParser {
  private buffer = '';
  private block: { kind: BlockKind; name?: string } | null = null;
  private readonly toolNames: Set<string>;

  constructor(toolNames: string[] = []) {
    this.toolNames = new Set(toolNames.map((n) => n.toLowerCase()));
  }

  push(text: string): ParserStep {
    this.buffer += text;
    let out = '';
    const calls: ParsedToolCall[] = [];

    for (;;) {
      if (this.block) {
        const closeRe =
          this.block.kind === 'tr'
            ? RE_CLOSE_TR
            : this.block.kind === 'fc'
              ? RE_CLOSE_FC
              : this.block.kind === 'tool'
                ? RE_CLOSE_TOOL
                : RE_CLOSE_LEGACY;
        const m = this.buffer.match(closeRe);
        if (m) {
          const body = this.buffer.slice(0, m.index);
          this.buffer = this.buffer.slice(m.index! + m[0].length);
          const { kind, name } = this.block;
          this.block = null;
          calls.push(...this.extract(kind, body, name));
          continue;
        }
        if (this.buffer.length > HOLD_CAP) {
          out += this.buffer;
          this.buffer = '';
          this.block = null;
          continue;
        }
        break;
      }

      const open = this.findOpener(this.buffer);
      if (open) {
        out += this.buffer.slice(0, open.index);
        this.buffer = this.buffer.slice(open.index + open.length);
        this.block = { kind: open.kind, name: open.name };
        continue;
      }

      // fenced JSON tool call appearing mid-text: emit preceding prose first
      if (this.toolNames.size > 0) {
        const fenceIdx = this.findFence(this.buffer);
        if (fenceIdx > 0) {
          out += this.buffer.slice(0, fenceIdx);
          this.buffer = this.buffer.slice(fenceIdx);
        }
      }

      const bare = this.tryBareJson();
      if (bare === 'hold') break;
      if (bare) {
        this.buffer = this.buffer.slice(bare.consumed);
        if (bare.call) calls.push(bare.call);
        else out += bare.text;
        continue;
      }

      const hold = this.trailingHold(this.buffer);
      if (hold > 0) {
        out += this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
      } else {
        out += this.buffer;
        this.buffer = '';
      }
      break;
    }
    return { text: out, calls };
  }

  flush(): ParserStep {
    const calls: ParsedToolCall[] = [];
    let text = '';
    if (this.block) {
      // unterminated block: only salvage dialects whose body is complete
      // (JSON envelope or invoke blocks); attribute dialects need a close tag
      const salvaged =
        this.block.kind === 'legacy' ? [] : this.extract(this.block.kind, this.buffer, this.block.name);
      if (salvaged.length) calls.push(...salvaged);
      this.block = null;
      this.buffer = '';
      return { text, calls };
    }
    const bare = this.tryBareJson();
    if (bare && bare !== 'hold' && bare.call) {
      calls.push(bare.call);
      this.buffer = '';
      return { text: '', calls };
    }
    text = this.buffer;
    this.buffer = '';
    return { text, calls };
  }

  private extract(kind: BlockKind, body: string, legacyName?: string): ParsedToolCall[] {
    if (kind === 'legacy') {
      if (!legacyName) return [];
      return [makeCall(legacyName, parseLegacyParams(body))];
    }
    const json = parseJsonCalls(body);
    if (json) return json;
    const invokes = parseInvokeBlocks(body);
    if (invokes.length) return invokes;
    return [];
  }

  private findOpener(buf: string): OpenerHit | null {
    const candidates: Array<OpenerHit | null> = [
      this.matchOpen(buf, RE_OPEN_TR, 'tr'),
      this.matchOpen(buf, RE_OPEN_FC, 'fc'),
      this.matchOpen(buf, RE_OPEN_TOOL, 'tool'),
      this.matchLegacy(buf),
    ];
    let best: OpenerHit | null = null;
    for (const c of candidates) {
      if (c && (!best || c.index < best.index)) best = c;
    }
    return best;
  }

  private matchOpen(buf: string, re: RegExp, kind: BlockKind): OpenerHit | null {
    const m = buf.match(re);
    if (!m) return null;
    return { index: m.index!, length: m[0].length, kind };
  }

  private matchLegacy(buf: string): OpenerHit | null {
    const m = buf.match(RE_OPEN_LEGACY);
    if (!m) return null;
    return { index: m.index!, length: m[0].length, kind: 'legacy', name: m[1] };
  }

  /**
   * Bare/fenced JSON tool call at the start of the buffer (dialect 5).
   * Returns 'hold' while the object is still incomplete.
   */
  private tryBareJson(): { consumed: number; call: ParsedToolCall | null; text: string } | 'hold' | null {
    if (this.toolNames.size === 0) return null;
    const m = this.buffer.match(/^\s*(?:```(?:json|tool|tool_call)?\s*)?/);
    const prefixLen = m ? m[0].length : 0;
    const rest = this.buffer.slice(prefixLen);
    if (!rest.startsWith('{')) return null;
    const end = scanBalancedObject(rest);
    if (end === -1) {
      return this.buffer.length > HOLD_CAP
        ? { consumed: this.buffer.length, call: null, text: this.buffer }
        : 'hold';
    }
    const candidate = rest.slice(0, end);
    let consumed = prefixLen + end;
    // consume a trailing closing fence when the object was fenced
    const after = rest.slice(end);
    const fence = after.match(/^\s*```/);
    if (fence && m && m[0].includes('```')) consumed += fence[0].length;
    let parsed: any = null;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return { consumed, call: null, text: this.buffer.slice(0, consumed) };
    }
    const name = typeof parsed?.name === 'string' ? parsed.name : null;
    const hasArgs = parsed && typeof parsed === 'object' && ('arguments' in parsed || 'args' in parsed);
    if (name && hasArgs && this.toolNames.has(name.toLowerCase())) {
      return { consumed, call: makeCall(name, parsed.arguments ?? parsed.args ?? {}), text: '' };
    }
    // valid JSON but not a declared tool call → keep the original text as-is
    return { consumed, call: null, text: this.buffer.slice(0, consumed) };
  }

  /** Index of a fenced-JSON block start (```json\n{...), or -1. */
  private findFence(buf: string): number {
    const m = buf.match(/```(?:json|tool_call|tool)?\s*\n\s*\{/);
    return m ? m.index! : -1;
  }

  /** Length of trailing text that could still grow into an opener tag. */
  private trailingHold(buf: string): number {
    const lt = buf.lastIndexOf('<');
    if (lt === -1) return 0;
    const tail = buf.slice(lt);
    if (tail.includes('>') || tail.length > TAIL_CAP) return 0;
    const lower = tail.toLowerCase();
    for (const p of OPENER_PREFIXES) {
      if (p.startsWith(lower) || lower.startsWith(p)) return buf.length - lt;
    }
    return 0;
  }
}

/** Batch helper for the non-streaming path. */
export function extractToolCalls(
  fullText: string,
  toolNames: string[] = [],
): { text: string; calls: ParsedToolCall[] } {
  const parser = new StreamingToolParser(toolNames);
  const step = parser.push(fullText);
  const fin = parser.flush();
  return { text: step.text + fin.text, calls: [...step.calls, ...fin.calls] };
}

export function toolNamesFromDefinitions(tools: Array<any> | undefined): string[] {
  if (!tools?.length) return [];
  return tools.map((t) => String(t?.function?.name ?? t?.name ?? '')).filter((n) => n && n !== 'unknown');
}
