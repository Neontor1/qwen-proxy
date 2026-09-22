/**
 * Small shared helpers: ids, jwt decoding, time formatting.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

/** OpenAI-style completion id. */
export function completionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

/** OpenAI-style tool call id. */
export function toolCallId(): string {
  return `call_${randomBytes(12).toString('hex')}`;
}

/** Short account/session id. */
export function shortId(prefix = 'id'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export interface JwtClaims {
  exp?: number;
  iat?: number;
  sub?: string;
  email?: string;
  [key: string]: unknown;
}

/** Decode a JWT payload without verifying the signature (we don't hold the key). */
export function decodeJwt(token: string): JwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

/** Milliseconds until a JWT expires (0 if unknown/invalid). */
export function jwtExpiresInMs(token: string): number {
  const claims = decodeJwt(token);
  if (!claims?.exp) return 0;
  return Math.max(0, claims.exp * 1000 - Date.now());
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function maskSecret(value: string | undefined | null, visible = 4): string {
  if (!value) return '';
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${value.slice(0, visible)}${'*'.repeat(Math.min(24, value.length - visible))}`;
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!name || !domain) return email;
  const shown = name.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}
