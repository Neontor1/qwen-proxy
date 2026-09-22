/**
 * SSE helpers shared by the chat streaming route and the dashboard log stream.
 * Built on the WHATWG ReadableStream API so it works under both Bun and Node.
 */

const encoder = new TextEncoder();

export function sseFormat(data: string | object, event?: string, id?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  let out = '';
  if (id) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  for (const line of payload.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

export interface SseChannelOptions {
  /** Heartbeat interval in ms (SSE comment). 0 disables. Default 15000. */
  heartbeatMs?: number;
  /** Heartbeat comment text. */
  heartbeatText?: string;
  /** Called when the stream is closed (client disconnect or server close). */
  onClose?: (reason: 'server' | 'client') => void;
}

export interface SseChannel {
  readable: ReadableStream<Uint8Array>;
  send(data: string | object, event?: string): void;
  comment(text: string): void;
  /** Send `data: [DONE]` and close the stream. */
  done(): void;
  close(): void;
  readonly closed: boolean;
}

export function createSseChannel(opts: SseChannelOptions = {}): SseChannel {
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function safeEnqueue(text: string): void {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      closed = true;
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function finish(reason: 'server' | 'client'): void {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
    opts.onClose?.(reason);
  }

  const readable = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          safeEnqueue(`: ${opts.heartbeatText ?? 'heartbeat'}\n\n`);
        }, heartbeatMs);
        // Don't keep the process alive just for heartbeats.
        if (typeof heartbeat === 'object' && 'unref' in heartbeat) {
          (heartbeat as NodeJS.Timeout).unref?.();
        }
      }
    },
    cancel() {
      finish('client');
    },
  });

  return {
    readable,
    get closed(): boolean {
      return closed;
    },
    send(data, event) {
      safeEnqueue(sseFormat(data, event));
    },
    comment(text) {
      safeEnqueue(`: ${text}\n\n`);
    },
    done() {
      safeEnqueue('data: [DONE]\n\n');
      finish('server');
    },
    close() {
      finish('server');
    },
  } as SseChannel;
}

/** Standard SSE response headers (OpenAI-compatible). */
export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

/**
 * Parse an SSE text stream incrementally. Feed chunks via push(); each parsed
 * `data:` payload is passed to onData in arrival order.
 */
export class SseParser {
  private buffer = '';

  constructor(private onData: (data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    // SSE events are separated by a blank line; tolerate \r\n.
    for (;;) {
      const idx = this.buffer.search(/\r?\n\r?\n/);
      if (idx === -1) break;
      const rawEvent = this.buffer.slice(0, idx);
      const sep = this.buffer.slice(idx).match(/^\r?\n\r?\n/)![0];
      this.buffer = this.buffer.slice(idx + sep.length);
      for (const line of rawEvent.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (data) this.onData(data);
      }
    }
  }

  /** Flush any trailing event without a final blank line. */
  flush(): void {
    if (!this.buffer.trim()) return;
    for (const line of this.buffer.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trimStart();
      if (data) this.onData(data);
    }
    this.buffer = '';
  }
}
