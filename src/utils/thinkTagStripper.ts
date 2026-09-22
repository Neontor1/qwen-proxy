/**
 * Streaming-aware stripper for <think> / <thinking> / <reasoning> blocks.
 * Handles tags split across chunk boundaries; everything inside a block is
 * dropped, an unclosed block at flush() is dropped as well.
 */

const BLOCK_OPEN = /<(think|thinking|reasoning)\b[^>]*>/i;
const BLOCK_CLOSE = /<\/(think|thinking|reasoning)\s*>/i;
const CLOSE_MAX_LEN = 32;

export class ThinkTagStripper {
  private buffer = '';
  private inBlock = false;

  /** Feed a chunk, get back the safe-to-emit text. */
  push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;
    let out = '';

    for (;;) {
      if (this.inBlock) {
        const close = this.buffer.match(BLOCK_CLOSE);
        if (close) {
          const end = close.index! + close[0].length;
          this.buffer = this.buffer.slice(end);
          this.inBlock = false;
          continue;
        }
        // No close tag yet: drop everything except a tail that might be a split close tag.
        if (this.buffer.length > CLOSE_MAX_LEN) {
          this.buffer = this.buffer.slice(-CLOSE_MAX_LEN);
        }
        break;
      }

      const open = this.buffer.match(BLOCK_OPEN);
      if (open) {
        out += this.buffer.slice(0, open.index!);
        this.buffer = this.buffer.slice(open.index! + open[0].length);
        this.inBlock = true;
        continue;
      }

      // No open tag: emit everything except a trailing partial "<thin..." candidate.
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

  /** Finalize the stream. A partial tag that never completed is emitted as text. */
  flush(): string {
    if (this.inBlock) {
      this.buffer = '';
      this.inBlock = false;
      return '';
    }
    const rest = this.buffer;
    this.buffer = '';
    return rest;
  }

  /** Length of the trailing substring that could still grow into a block open tag. */
  private trailingPartial(buf: string): number {
    const lt = buf.lastIndexOf('<');
    if (lt === -1) return 0;
    const tail = buf.slice(lt);
    const candidates = ['<think', '<thinking', '<reasoning'];
    for (const c of candidates) {
      if (c.startsWith(tail.toLowerCase()) && tail.length < c.length + 16) {
        // Only hold if the tail looks like the start of the tag (allow attrs after name).
        const namePart = tail.match(/^<([a-z]*)/i)?.[1]?.toLowerCase() ?? '';
        if (c.startsWith(`<${namePart}`)) return buf.length - lt;
      }
    }
    return 0;
  }
}

/** One-shot convenience for complete strings. */
export function stripThinkTags(text: string): string {
  const s = new ThinkTagStripper();
  return s.push(text) + s.flush();
}
