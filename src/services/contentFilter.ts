/**
 * Content filter pipeline — streaming removal of <think> blocks and XML
 * tool artifacts from model output. Composes ThinkTagStripper + XmlStripper.
 * Enabled per-request from config (CLEAN_OUTPUT, hot-reloadable).
 */
import { ThinkTagStripper } from '../utils/thinkTagStripper.js';
import { XmlStripper } from '../utils/xmlStripper.js';

export interface ContentFilterStream {
  /** Feed a raw chunk, receive the clean text safe to emit. */
  push(chunk: string): string;
  /** Finalize; may return held-back text. */
  flush(): string;
}

class PassthroughFilter implements ContentFilterStream {
  push(chunk: string): string {
    return chunk;
  }
  flush(): string {
    return '';
  }
}

class CleaningFilter implements ContentFilterStream {
  private think = new ThinkTagStripper();
  private xml = new XmlStripper();

  push(chunk: string): string {
    // Order matters: think blocks first (they may contain artifacts),
    // then XML artifacts from what remains.
    return this.xml.push(this.think.push(chunk));
  }

  flush(): string {
    return this.xml.flush() + this.think.flush();
  }
}

export function createContentFilter(enabled: boolean): ContentFilterStream {
  return enabled ? new CleaningFilter() : new PassthroughFilter();
}

/** One-shot filter for complete strings (non-streaming path). */
export function filterContent(text: string, enabled: boolean): string {
  const f = createContentFilter(enabled);
  return f.push(text) + f.flush();
}
