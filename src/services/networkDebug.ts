/**
 * Network debug — captures outbound calls to chat.qwen.ai (or the mock
 * provider) into a ring buffer for the dashboard Network page.
 * Recording is gated by the NETWORK_DEBUG config flag (hot-reloadable),
 * but the buffer keeps working when toggled on mid-flight.
 */
import { uuid } from '../utils/ids.js';
import { maskSecret } from '../utils/ids.js';

export interface NetworkCapture {
  id: string;
  ts: number;
  method: string;
  url: string;
  durationMs: number | null;
  status: number | null;
  requestHeaders: Record<string, string>;
  requestBodyPreview: string | null;
  responseHeaders: Record<string, string> | null;
  responseBodyPreview: string | null;
  error: string | null;
  /** which account/session triggered this call */
  accountId: string | null;
}

const BUFFER = 200;
const BODY_PREVIEW = 4000;

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'bx-ua', 'bx-umidtoken', 'x-master-key']);

function sanitizeHeaders(headers: Record<string, string> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: Array<[string, string]> = [];
  if (headers instanceof Headers) headers.forEach((v, k) => entries.push([k, v]));
  else entries.push(...Object.entries(headers));
  for (const [k, v] of entries) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? maskSecret(v, 8) : v;
  }
  return out;
}

function preview(body: unknown): string | null {
  if (body == null) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text.length > BODY_PREVIEW ? `${text.slice(0, BODY_PREVIEW)}… [truncated]` : text;
}

class NetworkDebug {
  private entries: NetworkCapture[] = [];
  private enabledOverride: boolean | null = null;

  setEnabled(on: boolean | null): void {
    this.enabledOverride = on;
  }

  isEnabled(): boolean {
    if (this.enabledOverride !== null) return this.enabledOverride;
    // Lazy import avoided: callers pass the flag from config.
    return false;
  }

  /** Start capturing a call; returns a handle to finish it. */
  begin(params: {
    method: string;
    url: string;
    headers?: Record<string, string> | Headers;
    body?: unknown;
    accountId?: string | null;
    enabled: boolean;
  }): {
    end(
      status: number | null,
      resHeaders?: Record<string, string> | Headers | null,
      resBody?: string | null,
      error?: string | null,
    ): void;
  } {
    if (!params.enabled && this.enabledOverride !== true) {
      return { end: () => {} };
    }
    const started = Date.now();
    const entry: NetworkCapture = {
      id: uuid(),
      ts: started,
      method: params.method,
      url: params.url,
      durationMs: null,
      status: null,
      requestHeaders: sanitizeHeaders(params.headers ?? {}),
      requestBodyPreview: preview(params.body),
      responseHeaders: null,
      responseBodyPreview: null,
      error: null,
      accountId: params.accountId ?? null,
    };
    return {
      end: (status, resHeaders, resBody, error) => {
        entry.durationMs = Date.now() - started;
        entry.status = status;
        entry.responseHeaders = resHeaders ? sanitizeHeaders(resHeaders) : null;
        entry.responseBodyPreview = preview(resBody);
        entry.error = error ?? null;
        this.entries.push(entry);
        if (this.entries.length > BUFFER) this.entries.splice(0, this.entries.length - BUFFER);
      },
    };
  }

  list(limit = 50): NetworkCapture[] {
    return [...this.entries].reverse().slice(0, limit);
  }

  get(id: string): NetworkCapture | undefined {
    return this.entries.find((e) => e.id === id);
  }

  clear(): void {
    this.entries = [];
  }
}

export const networkDebug = new NetworkDebug();

/**
 * fetch() wrapper that records the exchange in the Network page buffer.
 * Response body is NOT consumed — for streaming calls we only record
 * headers/status; callers can attach a body preview separately.
 */
export async function trackedFetch(
  input: string | URL,
  init: RequestInit & { accountId?: string | null; debugEnabled?: boolean; bodyPreview?: unknown } = {},
): Promise<Response> {
  const { accountId, debugEnabled = false, bodyPreview, ...rest } = init;
  const url = String(input);
  const handle = networkDebug.begin({
    method: rest.method ?? 'GET',
    url,
    headers: rest.headers as Record<string, string> | undefined,
    body: bodyPreview ?? (typeof rest.body === 'string' ? rest.body : undefined),
    accountId,
    enabled: debugEnabled,
  });
  try {
    const resp = await fetch(url, rest);
    handle.end(resp.status, resp.headers);
    return resp;
  } catch (err) {
    handle.end(null, null, null, String(err));
    throw err;
  }
}
