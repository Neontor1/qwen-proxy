import { describe, expect, it } from 'vitest/globals';
import { createContentFilter, filterContent } from '../src/services/contentFilter.js';
import { ThinkTagStripper } from '../src/utils/thinkTagStripper.js';
import { XmlStripper } from '../src/utils/xmlStripper.js';

const THINK_OPEN = '<' + 'think>';
const THINK_CLOSE = '<' + '/' + 'think' + '>';
const FC_OPEN = '<' + 'function_calls' + '>';
const FC_CLOSE = '<' + '/' + 'function_calls' + '>';

describe('ThinkTagStripper', () => {
  it('removes a whole block', () => {
    const s = new ThinkTagStripper();
    expect(s.push(`hello ${THINK_OPEN}secret reasoning${THINK_CLOSE} world`) + s.flush()).toBe(
      'hello  world',
    );
  });

  it('handles tags split across chunks', () => {
    const s = new ThinkTagStripper();
    let out = '';
    out += s.push('a ' + THINK_OPEN.slice(0, 4));
    out += s.push(THINK_OPEN.slice(4) + 'hidden');
    out += s.push(THINK_CLOSE.slice(0, 5));
    out += s.push(THINK_CLOSE.slice(5) + ' b');
    out += s.flush();
    expect(out).toBe('a  b');
  });

  it('drops an unclosed block at flush', () => {
    const s = new ThinkTagStripper();
    const out = s.push(`x ${THINK_OPEN}never closed`) + s.flush();
    expect(out).toBe('x ');
  });

  it('keeps plain text with angle brackets', () => {
    const s = new ThinkTagStripper();
    expect(s.push('a < b and c > d') + s.flush()).toBe('a < b and c > d');
  });
});

describe('XmlStripper', () => {
  it('removes function_calls blocks with content', () => {
    const s = new XmlStripper();
    const out = s.push(`before ${FC_OPEN} junk inside ${FC_CLOSE} after`) + s.flush();
    expect(out).toBe('before  after');
  });

  it('removes lone artifact tags', () => {
    const fnOpen = '<' + 'function=foo' + '>';
    const fnClose = '<' + '/' + 'function' + '>';
    const s = new XmlStripper();
    const out = s.push(`text ${fnOpen} more ${fnClose} end`) + s.flush();
    expect(out).toBe('text  more  end');
  });
});

describe('contentFilter pipeline', () => {
  it('strips think + artifacts from streamed text', () => {
    const f = createContentFilter(true);
    const raw = `${THINK_OPEN}hmm${THINK_CLOSE}Answer: 42 ${FC_OPEN}x${FC_CLOSE}!`;
    expect(f.push(raw) + f.flush()).toBe('Answer: 42 !');
  });

  it('passes everything through when disabled', () => {
    const raw = `${THINK_OPEN}hmm${THINK_CLOSE}keep`;
    expect(filterContent(raw, false)).toBe(raw);
  });
});
