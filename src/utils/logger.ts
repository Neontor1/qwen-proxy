/**
 * Core logging utility with levels, ANSI colors, scopes and pluggable sinks.
 * services/systemLogger.ts subscribes a ring-buffer sink for the dashboard.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export type LogSink = (record: LogRecord) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const sinks: LogSink[] = [];
const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

export function setLogLevel(level: LogLevel): void {
  if (LEVEL_ORDER[level] !== undefined) minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const idx = sinks.indexOf(sink);
    if (idx >= 0) sinks.splice(idx, 1);
  };
}

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
}

function safeInspect(data: unknown): string {
  try {
    if (data instanceof Error) return data.stack || data.message;
    if (typeof data === 'string') return data;
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
    // Still deliver to sinks (dashboard may want debug), but not to console.
    for (const sink of sinks) {
      try {
        sink({ ts: Date.now(), level, scope, message, data });
      } catch {
        /* sink must never break logging */
      }
    }
    return;
  }
  const ts = Date.now();
  const line = colorEnabled
    ? `${DIM}${formatTs(ts)}${RESET} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${DIM}[${scope}]${RESET} ${message}${data !== undefined ? ` ${DIM}${safeInspect(data)}${RESET}` : ''}`
    : `${formatTs(ts)} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${data !== undefined ? ` ${safeInspect(data)}` : ''}`;

  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);

  for (const sink of sinks) {
    try {
      sink({ ts, level, scope, message, data });
    } catch {
      /* ignore */
    }
  }
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, data) => emit('debug', scope, msg, data),
    info: (msg, data) => emit('info', scope, msg, data),
    warn: (msg, data) => emit('warn', scope, msg, data),
    error: (msg, data) => emit('error', scope, msg, data),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('qwen-proxy');
