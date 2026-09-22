/**
 * CORS headers for the public API + dashboard API.
 * Permissive by default (self-hosted tool, clients run anywhere).
 */
import type { Context, MiddlewareHandler, Next } from 'hono';

export function cors(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const origin = c.req.header('origin');
    c.header('Access-Control-Allow-Origin', origin ?? '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Master-Key');
    c.header('Access-Control-Max-Age', '86400');
    c.header('Vary', 'Origin');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  };
}
