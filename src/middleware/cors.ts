/**
 * CORS headers for the public API + dashboard API.
 * Configurable via environment variables:
 * - CORS_ALLOWED_ORIGINS: comma-separated list of allowed origins (default: '*' for self-hosted)
 * - CORS_CREDENTIALS: whether to allow credentials (default: 'false')
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { configService } from '../services/configService.js';

export function cors(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const cfg = configService.get();
    const origin = c.req.header('origin');
    
    // Support configurable allowed origins
    const allowedOriginsStr = process.env.CORS_ALLOWED_ORIGINS || cfg.HOST === '0.0.0.0' ? '*' : `http://${cfg.HOST}:${cfg.PORT}`;
    const allowedOrigins = allowedOriginsStr.split(',').map((o) => o.trim());
    
    // If specific origins are configured, validate the request origin
    let responseOrigin = '*';
    if (allowedOrigins.length > 1 || (allowedOrigins.length === 1 && allowedOrigins[0] !== '*')) {
      if (origin && allowedOrigins.includes(origin)) {
        responseOrigin = origin;
      } else {
        responseOrigin = allowedOrigins[0] ?? '*';
      }
    } else if (origin) {
      responseOrigin = origin;
    }
    
    c.header('Access-Control-Allow-Origin', responseOrigin);
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Master-Key, X-Api-Key');
    c.header('Access-Control-Max-Age', '86400');
    
    // Allow credentials if explicitly enabled
    const allowCredentials = process.env.CORS_CREDENTIALS?.toLowerCase() === 'true';
    if (allowCredentials && responseOrigin !== '*') {
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    
    c.header('Vary', 'Origin');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  };
}
