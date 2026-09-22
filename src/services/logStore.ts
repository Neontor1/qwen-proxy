/**
 * Request log store — in-memory ring buffer of API request logs with optional
 * JSONL persistence (SAVE_REQUEST_LOGS) and SSE broadcast to the dashboard.
 */
import { appendFileSync } from 'node:fs';
import { uuid } from '../utils/ids.js';
import { createLogger } from '../utils/logger.js';
import { paths } from '../utils/paths.js';
import { configService } from './configService.js';

const log = createLogger('logstore');

export interface RequestLogEntry {
  id: string;
  timestamp: number;
  /** API route, e.g. /v1/chat/completions */
  route: string;
  model: string;
  /** account id used (masked email is resolved in the UI) */
  accountId: string | null;
  accountEmail: string | null;
  durationMs: number;
  status: number;
  stream: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  error: string | null;
  clientIp: string | null;
  /** Only populated when NETWORK_DEBUG / SAVE_REQUEST_LOGS asks for bodies. */
  requestBody?: unknown;
  responseBody?: string;
}

export interface LogQuery {
  limit?: number;
  offset?: number;
  model?: string;
  accountId?: string;
  status?: number | 'error' | 'success';
  since?: number;
  q?: string;
}

type Listener = (entry: RequestLogEntry) => void;

class LogStore {
  private buffer: RequestLogEntry[] = [];
  private listeners: Listener[] = [];
  private totalLogged = 0;

  add(
    entry: Omit<RequestLogEntry, 'id' | 'timestamp'> & Partial<Pick<RequestLogEntry, 'id' | 'timestamp'>>,
  ): RequestLogEntry {
    const full: RequestLogEntry = {
      id: entry.id ?? uuid(),
      timestamp: entry.timestamp ?? Date.now(),
      ...entry,
    } as RequestLogEntry;
    const cfg = configService.get();
    this.buffer.push(full);
    const cap = Math.max(50, cfg.LOG_BUFFER_SIZE || 500);
    if (this.buffer.length > cap) this.buffer.splice(0, this.buffer.length - cap);
    this.totalLogged++;

    if (cfg.SAVE_REQUEST_LOGS) {
      try {
        appendFileSync(paths.requestLog(), `${JSON.stringify(full)}\n`);
      } catch (err) {
        log.error('failed to persist request log', String(err));
      }
    }
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        /* ignore */
      }
    }
    return full;
  }

  query(q: LogQuery = {}): { entries: RequestLogEntry[]; total: number } {
    let entries = this.buffer;
    if (q.model) entries = entries.filter((e) => e.model === q.model);
    if (q.accountId) entries = entries.filter((e) => e.accountId === q.accountId);
    if (q.status === 'error') entries = entries.filter((e) => e.status >= 400);
    else if (q.status === 'success') entries = entries.filter((e) => e.status < 400);
    else if (typeof q.status === 'number') entries = entries.filter((e) => e.status === q.status);
    if (q.since) entries = entries.filter((e) => e.timestamp >= q.since!);
    if (q.q) {
      const needle = q.q.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.model.toLowerCase().includes(needle) ||
          (e.accountEmail ?? '').toLowerCase().includes(needle) ||
          (e.error ?? '').toLowerCase().includes(needle),
      );
    }
    const total = entries.length;
    const ordered = [...entries].reverse(); // newest first
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 100;
    return { entries: ordered.slice(offset, offset + limit), total };
  }

  clear(): void {
    this.buffer = [];
  }

  stats(): { buffered: number; totalLogged: number } {
    return { buffered: this.buffer.length, totalLogged: this.totalLogged };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

export const logStore = new LogStore();
