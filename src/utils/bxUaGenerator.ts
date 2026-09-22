/**
 * bx-ua / bx-umidtoken generation for chat.qwen.ai anti-bot headers.
 *
 * Strategy (mirrors community proxies):
 *  1. Prefer a real browser session (Playwright) that can run the Baxia SDK —
 *     handled by services/playwright.ts which may override these values.
 *  2. Fallback: synthesize a plausible fingerprint payload, base64-encode it
 *     with the baxia version prefix, and fetch a umid token from Alibaba's
 *     wu.json endpoint (cached).
 *
 * NOTE: upstream may tighten validation at any time; if the real provider
 * starts rejecting requests, enable browser-based token generation
 * (BROWSER_LOGIN=true) or refresh BAXIA_VERSION.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('bxua');

export const BAXIA_VERSION = '2.5.37';

export const WEB_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const WEB_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

export interface BaxiaTokens {
  bxUa: string;
  bxUmidToken: string;
  bxV: string;
  cookies?: string;
}

const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
const languages = ['en-US', 'zh-CN', 'en-GB'];
const webglRenderers = [
  'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)',
  'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.6)',
];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomString(length: number): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

function cryptoHash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function collectFingerprintData(): Record<string, unknown> {
  return {
    p: rand(platforms),
    l: rand(languages),
    hc: 4 + Math.floor(Math.random() * 12),
    dm: rand([4, 8, 16, 32]),
    to: rand([-480, -300, 0, 60, 480]),
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: rand([1, 1.25, 1.5, 2]),
    wf: rand(webglRenderers).substring(0, 20),
    cf: cryptoHash(randomBytes(32)),
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random(),
  };
}

export function encodeBaxiaToken(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  return `${BAXIA_VERSION.replace(/\./g, '')}!${Buffer.from(json, 'utf8').toString('base64')}`;
}

async function fetchUmidToken(): Promise<string> {
  try {
    const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': WEB_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    const body = await resp.text();
    const m = body.match(/umx\.wu\('([^']+)'\)/) || body.match(/'([^']+)'/);
    const token = m?.[1] || resp.headers.get('etag') || '';
    if (token && /^T2gA/i.test(token)) return token;
  } catch (err) {
    log.debug('wu.json fetch failed', String(err));
  }
  return `T2gA${randomString(40)}`;
}

let cache: BaxiaTokens | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Get (cached) synthetic baxia tokens. Pass forceRefresh after a risk-control rejection. */
export async function getBaxiaTokens(forceRefresh = false): Promise<BaxiaTokens> {
  const now = Date.now();
  if (!forceRefresh && cache && now - cacheTime < CACHE_TTL_MS) return cache;
  const bxUa = encodeBaxiaToken(collectFingerprintData());
  const bxUmidToken = await fetchUmidToken();
  const tokens: BaxiaTokens = { bxUa, bxUmidToken, bxV: BAXIA_VERSION };
  cache = tokens;
  cacheTime = now;
  return tokens;
}
