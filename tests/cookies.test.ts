import { describe, expect, it } from 'bun:test';
import {
  auditCookies,
  cookieNamesFromHeader,
  filterForQwen,
  maskCookieList,
  mergeCookieHeaders,
  parseCookies,
  toCookieHeader,
} from '../src/utils/cookies.js';

const EDITOR_JSON = JSON.stringify([
  { name: 'cna', value: 'cna-value', domain: '.qwen.ai', httpOnly: false },
  { name: 'token', value: 'jwt-token', domain: 'chat.qwen.ai', httpOnly: true },
  { name: 'ssxmod_itna', value: 's1', domain: '.qwen.ai' },
  { name: 'ssxmod_itna2', value: 's2', domain: '.qwen.ai' },
  { name: 'isg', value: 'i1', domain: '.qwen.ai' },
  { name: 'unrelated_site_session', value: 'nope', domain: '.example.com' },
]);

describe('cookie parsing (Cookie-Editor & friends)', () => {
  it('parses a Cookie-Editor JSON export and filters foreign domains', () => {
    const res = parseCookies(EDITOR_JSON);
    expect(res.format).toBe('cookie-editor-json');
    expect(res.cookies.length).toBe(6);
    const { kept, dropped } = filterForQwen(res.cookies);
    expect(kept.map((c) => c.name)).toContain('token');
    expect(dropped.map((c) => c.name)).toEqual(['unrelated_site_session']);
    expect(toCookieHeader(kept)).toContain('token=jwt-token');
  });

  it('parses a raw Cookie: header', () => {
    const res = parseCookies('cna=a1; token=t1; ssxmod_itna=s1; ssxmod_itna2=s2; tfstk=f1');
    expect(res.format).toBe('header');
    expect(res.cookies.length).toBe(5);
    const audit = auditCookies(res.cookies);
    expect(audit.ok).toBe(true);
    expect(audit.missing).toEqual([]);
    expect(audit.recommended).toContain('tfstk');
  });

  it('parses JSON object, multiline and netscape formats', () => {
    expect(parseCookies('{"cna":"a","token":"t"}').format).toBe('object');
    expect(parseCookies('cna=a\ntoken=t\n').format).toBe('lines');
    const netscape = [
      '# comment',
      '.qwen.ai\tTRUE\t/\tFALSE\t0\tcna\tvv1',
      '.qwen.ai\tTRUE\t/\tTRUE\t0\ttoken\tvv2',
    ].join('\n');
    const res = parseCookies(netscape);
    expect(res.format).toBe('netscape');
    expect(res.cookies.map((c) => c.name)).toEqual(['cna', 'token']);
    expect(res.cookies[1]!.secure).toBe(true);
  });

  it('audits missing required cookies', () => {
    const audit = auditCookies(parseCookies('cna=only-cna').cookies);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(['token', 'ssxmod_itna', 'ssxmod_itna2']);
    expect(audit.present).toEqual(['cna']);
  });

  it('merges headers (right wins) and masks values', () => {
    const merged = mergeCookieHeaders('a=1; b=2', 'b=22; c=3', undefined);
    expect(merged).toBe('a=1; b=22; c=3');
    const masked = maskCookieList(parseCookies('token=abcdefghij').cookies);
    expect(masked[0]!.value).not.toContain('defgh');
    expect(masked[0]!.value.startsWith('abc')).toBe(true);
  });

  it('cookieNamesFromHeader lists names', () => {
    expect(cookieNamesFromHeader('cna=1; token=2; isg=3')).toEqual(['cna', 'token', 'isg']);
  });

  it('keeps everything when the domain filter would drop the session', () => {
    const res = parseCookies(EDITOR_JSON.replace(/qwen\.ai/g, 'example.com'));
    const { kept } = filterForQwen(res.cookies);
    // required cookies are known names → they survive even on a foreign domain
    expect(kept.map((c) => c.name)).toContain('token');
  });
});
