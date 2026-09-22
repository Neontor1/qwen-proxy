/**
 * Cookie parsing / auditing for cookie-based Qwen accounts.
 *
 * chat.qwen.ai sessions are carried by a handful of cookies; community
 * captures (Cookie-Editor exports, OmniRoute `webSessionCredentials`) agree on
 * the required set: `cna`, `token`, `ssxmod_itna`, `ssxmod_itna2` (plus the
 * usual Alibaba anti-bot family `isg`, `tfstk`, `atpsida`, …).
 *
 * Accepted input formats (auto-detected):
 *   1. Cookie-Editor JSON export  — [{name, value, domain, …}, …]
 *   2. Raw `Cookie:` header       — "cna=…; token=…; …"
 *   3. Plain object               — {"cna": "…", "token": "…"}
 *   4. Netscape cookies.txt       — tab-separated 7-column lines
 *   5. One `name=value` per line
 */

export interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export type CookieInputFormat = 'cookie-editor-json' | 'header' | 'object' | 'netscape' | 'lines';

export interface ParseResult {
  cookies: ParsedCookie[];
  format: CookieInputFormat;
  warnings: string[];
}

/** Without these chat.qwen.ai rejects the session. */
export const REQUIRED_COOKIES = ['cna', 'token', 'ssxmod_itna', 'ssxmod_itna2'] as const;
/** Anti-bot family: strongly recommended, usually present in a real session. */
export const RECOMMENDED_COOKIES = ['isg', 'tfstk', 'atpsida', 'aui', 'cnaui', 'sca'] as const;

const QWEN_DOMAIN_RE = /(^|\.)qwen\.ai$/i;
const SHARED_DOMAIN_RE =
  /(^|\.)alibaba\.(com|net)$|(^|\.)aliyun\.com$|(^|\.)taobao\.com$|(^|\.)mmstat\.com$/i;
const KNOWN_NAMES = new Set<string>([
  ...REQUIRED_COOKIES,
  ...RECOMMENDED_COOKIES,
  'login',
  'sid',
  'xlly',
  'sgcookie',
]);

function clean(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

function pushCookie(map: Map<string, ParsedCookie>, cookie: ParsedCookie): void {
  if (!cookie.name || !cookie.value) return;
  map.set(cookie.name, cookie);
}

function parseHeaderLike(text: string, format: CookieInputFormat, map: Map<string, ParsedCookie>): number {
  let n = 0;
  for (const part of text.split(/;|\r?\n/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = clean(part.slice(eq + 1));
    if (!name || !value) continue;
    pushCookie(map, { name, value });
    n++;
  }
  void format;
  return n;
}

function parseNetscape(text: string, map: Map<string, ParsedCookie>): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cols = t.split('\t');
    if (cols.length < 7) continue;
    pushCookie(map, {
      name: cols[5]!.trim(),
      value: clean(cols[6] ?? ''),
      domain: cols[0]?.trim(),
      path: cols[2]?.trim(),
      httpOnly: cols[1]?.trim().toUpperCase() === 'TRUE',
      secure: cols[3]?.trim().toUpperCase() === 'TRUE',
    });
    n++;
  }
  return n;
}

/** Auto-detect the format and parse. Never throws. */
export function parseCookies(input: string): ParseResult {
  const warnings: string[] = [];
  const map = new Map<string, ParsedCookie>();
  const text = (input ?? '').trim();
  if (!text) return { cookies: [], format: 'header', warnings: ['empty input'] };

  // JSON payloads
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        for (const entry of json) {
          if (!entry || typeof entry !== 'object') continue;
          const e = entry as Record<string, unknown>;
          const name = String(e.name ?? e.key ?? '').trim();
          const value = String(e.value ?? '').trim();
          if (!name || !value) continue;
          pushCookie(map, {
            name,
            value: clean(value),
            domain: e.domain ? String(e.domain) : undefined,
            path: e.path ? String(e.path) : undefined,
            httpOnly: Boolean(e.httpOnly),
            secure: Boolean(e.secure),
          });
        }
        return { cookies: [...map.values()], format: 'cookie-editor-json', warnings };
      }
      if (typeof json === 'object' && json !== null) {
        for (const [name, value] of Object.entries(json)) {
          if (typeof value === 'string' && value) pushCookie(map, { name, value: clean(value) });
        }
        return { cookies: [...map.values()], format: 'object', warnings };
      }
    } catch {
      warnings.push('looks like JSON but failed to parse — treated as raw header');
    }
  }

  // Netscape cookies.txt (tab separated)
  if (text.includes('\t') && text.split(/\r?\n/).some((l) => l.split('\t').length >= 7)) {
    parseNetscape(text, map);
    return { cookies: [...map.values()], format: 'netscape', warnings };
  }

  // multiline name=value
  if (text.includes('\n')) {
    parseHeaderLike(text, 'lines', map);
    return { cookies: [...map.values()], format: 'lines', warnings };
  }

  parseHeaderLike(text, 'header', map);
  return { cookies: [...map.values()], format: 'header', warnings };
}

/** Keep cookies that can belong to a chat.qwen.ai session. */
export function filterForQwen(cookies: ParsedCookie[]): { kept: ParsedCookie[]; dropped: ParsedCookie[] } {
  const withDomain = cookies.filter((c) => c.domain);
  if (!withDomain.length) return { kept: cookies, dropped: [] };
  const kept: ParsedCookie[] = [];
  const dropped: ParsedCookie[] = [];
  for (const c of cookies) {
    const domainOk = !c.domain || QWEN_DOMAIN_RE.test(c.domain) || SHARED_DOMAIN_RE.test(c.domain);
    const nameOk = KNOWN_NAMES.has(c.name.toLowerCase());
    if (domainOk || nameOk) kept.push(c);
    else dropped.push(c);
  }
  // If the filter was too aggressive (e.g. an export from another site), keep everything.
  if (!kept.some((c) => REQUIRED_COOKIES.includes(c.name as (typeof REQUIRED_COOKIES)[number]))) {
    return { kept: cookies, dropped: [] };
  }
  return { kept, dropped };
}

/** Serialize back into a `Cookie:` header value. */
export function toCookieHeader(cookies: ParsedCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Merge two `Cookie:` header strings (right side wins per name). */
export function mergeCookieHeaders(...headers: Array<string | undefined | null>): string {
  const map = new Map<string, string>();
  for (const header of headers) {
    if (!header) continue;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      map.set(part.slice(0, eq).trim(), clean(part.slice(eq + 1)));
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export interface CookieAudit {
  present: string[];
  missing: string[];
  recommended: string[];
  ok: boolean;
  total: number;
}

/** Check the parsed set against what chat.qwen.ai is known to require. */
export function auditCookies(cookies: ParsedCookie[]): CookieAudit {
  const names = new Set(cookies.map((c) => c.name.toLowerCase()));
  const present = REQUIRED_COOKIES.filter((n) => names.has(n));
  const missing = REQUIRED_COOKIES.filter((n) => !names.has(n));
  const recommended = RECOMMENDED_COOKIES.filter((n) => names.has(n));
  return { present, missing, recommended, ok: missing.length === 0, total: cookies.length };
}

/** Names + masked values for safe display in the dashboard / API. */
export function maskCookieList(cookies: ParsedCookie[]): Array<{ name: string; value: string }> {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value.length <= 6 ? '*'.repeat(c.value.length) : `${c.value.slice(0, 3)}…${c.value.slice(-2)}`,
  }));
}

/** Cookie names present in a raw header (for quick badges). */
export function cookieNamesFromHeader(header: string): string[] {
  return header
    .split(';')
    .map((p) => p.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}
