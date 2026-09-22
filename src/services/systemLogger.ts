/**
 * System logger service — keeps a ring buffer of recent system log records
 * (fed from utils/logger sinks) and broadcasts them to dashboard SSE clients.
 * Optionally appends to logs/system.log.
 */
import { appendFileSync } from 'node:fs';
import { type LogRecord, addLogSink, setLogLevel } from '../utils/logger.js';
import { paths } from '../utils/paths.js';
import { configService } from './configService.js';

const BUFFER_SIZE = 1000;

type Listener = (record: LogRecord) => void;

class SystemLogger {
  private buffer: LogRecord[] = [];
  private listeners: Listener[] = [];
  private fileEnabled = true;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    addLogSink((record) => this.push(record));
    setLogLevel(configService.get().LOG_LEVEL);
    configService.onChange((cfg) => setLogLevel(cfg.LOG_LEVEL));
  }

  private push(record: LogRecord): void {
    this.buffer.push(record);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.splice(0, this.buffer.length - BUFFER_SIZE);
    if (this.fileEnabled && record.level !== 'debug') {
      try {
        appendFileSync(paths.systemLog(), `${JSON.stringify(record)}\n`);
      } catch {
        /* best effort */
      }
    }
    for (const l of this.listeners) {
      try {
        l(record);
      } catch {
        /* ignore */
      }
    }
  }

  recent(limit = 200, level?: string): LogRecord[] {
    const filtered = level ? this.buffer.filter((r) => r.level === level) : this.buffer;
    return filtered.slice(-limit);
  }

  clear(): void {
    this.buffer = [];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

export const systemLogger = new SystemLogger();
