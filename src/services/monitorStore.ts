/**
 * Monitoring store — rolling performance metrics for the dashboard overview:
 * requests/min, success rate, latency percentiles, per-model and per-account
 * counters. All in-memory, fixed-size windows.
 */

export interface RequestMetric {
  ts: number;
  model: string;
  accountId: string | null;
  durationMs: number;
  ok: boolean;
  status: number;
  totalTokens: number | null;
}

const WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const MAX_SAMPLES = 5000;

interface ModelStats {
  requests: number;
  errors: number;
  avgLatencyMs: number;
  lastUsed: number | null;
  lastError: string | null;
}

class MonitorStore {
  private samples: RequestMetric[] = [];
  private startedAt = Date.now();
  private inflight = 0;
  private peakInflight = 0;
  private totalRequests = 0;
  private totalErrors = 0;
  private totalTokens = 0;

  requestStarted(): void {
    this.inflight++;
    this.peakInflight = Math.max(this.peakInflight, this.inflight);
  }

  record(metric: RequestMetric): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.samples.push(metric);
    this.totalRequests++;
    if (!metric.ok) this.totalErrors++;
    if (metric.totalTokens) this.totalTokens += metric.totalTokens;
    this.prune();
  }

  /** Record a failure that never produced a full metric (e.g. validation). */
  recordFailure(model: string, status: number): void {
    this.record({
      ts: Date.now(),
      model,
      accountId: null,
      durationMs: 0,
      ok: false,
      status,
      totalTokens: null,
    });
  }

  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.samples.length && (this.samples[0]!.ts < cutoff || this.samples.length > MAX_SAMPLES)) {
      this.samples.shift();
    }
  }

  snapshot(): {
    uptimeSec: number;
    inflight: number;
    peakInflight: number;
    totalRequests: number;
    totalErrors: number;
    totalTokens: number;
    requestsPerMin: number;
    successRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    window: {
      requests: number;
      errors: number;
      perMin: Array<{ ts: number; count: number; errors: number }>;
    };
    models: Record<string, ModelStats>;
    accounts: Record<string, { requests: number; errors: number; tokens: number }>;
  } {
    this.prune();
    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    const inWindow = this.samples.filter((s) => s.ts >= windowStart);
    const minutes = Math.max(1, WINDOW_MS / 60_000);

    // per-minute buckets for the sparkline
    const buckets = new Map<number, { count: number; errors: number }>();
    for (const s of inWindow) {
      const bucket = Math.floor(s.ts / 60_000) * 60_000;
      const b = buckets.get(bucket) ?? { count: 0, errors: 0 };
      b.count++;
      if (!s.ok) b.errors++;
      buckets.set(bucket, b);
    }
    const perMin = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, v]) => ({ ts, count: v.count, errors: v.errors }));

    const latencies = inWindow.map((s) => s.durationMs).sort((a, b) => a - b);
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p95 = latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!
      : 0;

    const models: Record<string, ModelStats> = {};
    for (const s of inWindow) {
      const m = models[s.model] ?? {
        requests: 0,
        errors: 0,
        avgLatencyMs: 0,
        lastUsed: null,
        lastError: null,
      };
      m.requests++;
      if (!s.ok) m.errors++;
      m.lastUsed = s.ts;
      models[s.model] = m;
    }
    for (const [name, m] of Object.entries(models)) {
      const ls = inWindow.filter((s) => s.model === name);
      m.avgLatencyMs = Math.round(ls.reduce((a, s) => a + s.durationMs, 0) / Math.max(1, ls.length));
    }

    const accounts: Record<string, { requests: number; errors: number; tokens: number }> = {};
    for (const s of inWindow) {
      if (!s.accountId) continue;
      const a = accounts[s.accountId] ?? { requests: 0, errors: 0, tokens: 0 };
      a.requests++;
      if (!s.ok) a.errors++;
      a.tokens += s.totalTokens ?? 0;
      accounts[s.accountId] = a;
    }

    const errorsInWindow = inWindow.filter((s) => !s.ok).length;
    return {
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      inflight: this.inflight,
      peakInflight: this.peakInflight,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      totalTokens: this.totalTokens,
      requestsPerMin: Math.round((inWindow.length / minutes) * 10) / 10,
      successRate: inWindow.length
        ? Math.round(((inWindow.length - errorsInWindow) / inWindow.length) * 1000) / 10
        : 100,
      avgLatencyMs: Math.round(avg),
      p95LatencyMs: p95,
      window: { requests: inWindow.length, errors: errorsInWindow, perMin },
      models,
      accounts,
    };
  }
}

export const monitorStore = new MonitorStore();
