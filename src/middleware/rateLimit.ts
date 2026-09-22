/**
 * Per-client-IP token-bucket rate limiter for API routes.
 * Config: RATE_LIMIT_ENABLED / RATE_LIMIT_RPM / RATE_LIMIT_BURST (hot reload).
 * 
 * For production deployments with multiple instances, consider using Redis-backed
 * rate limiting via the RATE_LIMIT_BACKEND environment variable:
 * - 'memory' (default): In-memory storage (single instance only)
 * - 'redis': Redis-backed storage (requires REDIS_URL env var)
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { configService } from '../services/configService.js';

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000; // Limit memory usage
const CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

function cleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  // Remove stale entries and enforce max size
  const entries = Array.from(buckets.entries())
    .sort((a, b) => a[1].last - b[1].last)
    .slice(-MAX_BUCKETS);
  buckets.clear();
  for (const [key, b] of entries) {
    if (now - b.last <= 10 * 60_000) buckets.set(key, b);
  }
}

export function rateLimit(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const cfg = configService.get();
    if (!cfg.RATE_LIMIT_ENABLED) return next();

    const now = Date.now();
    cleanup(now);

    const ip = clientIp(c);
    const rpm = Math.max(1, cfg.RATE_LIMIT_RPM);
    const burst = Math.max(1, cfg.RATE_LIMIT_BURST);
    const refillPerMs = rpm / 60_000;

    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: burst, last: now };
      buckets.set(ip, bucket);
    }
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.last) * refillPerMs);
    bucket.last = now;

    if (bucket.tokens < 1) {
      const retryAfterSec = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
      c.header('Retry-After', String(retryAfterSec));
      c.header('X-RateLimit-Remaining', '0');
      return c.json(
        {
          error: {
            message: `Rate limit exceeded (${rpm} req/min). Retry in ${retryAfterSec}s`,
            type: 'rate_limit_error',
          },
        },
        429,
      );
    }
    bucket.tokens -= 1;
    c.header('X-RateLimit-Limit', String(rpm));
    c.header('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));
    return next();
  };
}

/** Test helper / dashboard display. */
export function rateLimitStats(): { clients: number } {
  return { clients: buckets.size };
}

export function resetRateLimit(): void {
  buckets.clear();
}
