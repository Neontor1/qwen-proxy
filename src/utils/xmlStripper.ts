/**
 * Streaming-aware stripper for XML tool-call artifacts that leak into Qwen
 * text output: <function=...>, <parameter=...>, <tool>, <function_calls>,
 * <invoke name="...">, </antml:...> etc.
 *
 * Paired blocks like <function_calls>...</function_calls> are removed
 * INCLUDING their contents; lone artifact tags are removed as single tokens.
 * NOTE: run xmlToolParser BEFORE this stripper so tool calls are extracted
 * from the raw text first.
 */

/** Block tags whose entire content must disappear. */
const BLOCK_TAGS = ['function_calls', 'tool_use', 'tools_response'];
/** Single-token artifact tags (open or close). */
const TOKEN_TAG =
  /<\/?(?:function|parameter|tool|invoke|antml:[a-zA-Z_]+|function_calls|tool_use)(?:\s[^>]*|=[^>\s]*)?\s*\/?>/gi;

const BLOCK_OPEN = new RegExp(`<(${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'i');
const BLOCK_CLOSE_FOR = (tag: string) => new RegExp(`</${tag}\\s*>`, 'i');

const HOLD_MAX = 64;

export class XmlStripper {
  private buffer = '';
  private blockTag: string | null = null;

  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    let out = '';

    for (;;) {
      if (this.blockTag) {
        const closeRe = BLOCK_CLOSE_FOR(this.blockTag);
        const close = this.buffer.match(closeRe);
        if (close) {
          this.buffer = this.buffer.slice(close.index! + close[0].length);
          this.blockTag = null;
          continue;
        }
        // Keep a small tail in case the close tag is split across chunks.
        if (this.buffer.length > HOLD_MAX) this.buffer = this.buffer.slice(-HOLD_MAX);
        break;
      }

      const blockOpen = this.buffer.match(BLOCK_OPEN);
      const token = this.nextTokenMatch(this.buffer);

      if (blockOpen && (!token || blockOpen.index! <= (token.index ?? 0))) {
        out += this.buffer.slice(0, blockOpen.index!);
        this.blockTag = blockOpen[1]!.toLowerCase();
        this.buffer = this.buffer.slice(blockOpen.index! + blockOpen[0].length);
        continue;
      }
      if (token) {
        const at = token.index ?? 0;
        out += this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + token[0].length);
        continue;
      }

      const hold = this.trailingPartial(this.buffer);
      if (hold > 0) {
        out += this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
      } else {
        out += this.buffer;
        this.buffer = '';
      }
      break;
    }
    return out;
  }

  flush(): string {
    if (this.blockTag) {
      this.buffer = '';
      this.blockTag = null;
      return '';
    }
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }

  private nextTokenMatch(buf: string): RegExpMatchArray | null {
    TOKEN_TAG.lastIndex = 0;
    return TOKEN_TAG.exec(buf);
  }

  /** Trailing substring that could still grow into an artifact tag. */
  private trailingPartial(buf: string): number {
    const lt = buf.lastIndexOf('<');
    if (lt === -1) return 0;
    const tail = buf.slice(lt);
    if (tail.length >= HOLD_MAX) return 0; // don't hold absurdly long tails
    // Only hold if the tail is a strict prefix of "<name..." or "</name..."
    // for one of the known artifact names and hasn't reached '>' yet.
    if (tail.includes('>')) return 0;
    const names = [
      'function',
      'parameter',
      'tool',
      'invoke',
      'antml:',
      'function_calls',
      'tool_use',
      'tools_response',
    ];
    const m = tail.match(/^<\/?([a-zA-Z_:]*)$/);
    if (!m) return 0;
    const typed = m[1]!.toLowerCase();
    for (const n of names) {
      if (n.startsWith(typed)) return buf.length - lt;
    }
    return 0;
  }
}

export function stripXmlArtifacts(text: string): string {
  const s = new XmlStripper();
  return s.push(text) + s.flush();
}
