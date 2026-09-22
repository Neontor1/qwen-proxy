import { describe, expect, it } from 'vitest';
import {
  StreamingToolParser,
  extractToolCalls,
  toolNamesFromDefinitions,
} from '../src/tools/xmlToolParser.js';

const TR_OPEN = '<' + 'tool_response>';
const TR_CLOSE = '<' + '/' + 'tool_response>';
const ANT_TR_OPEN = '<' + ['ant', 'ml:'].join('') + 'tool_response>';
const ANT_TR_CLOSE = '<' + '/' + ['ant', 'ml:'].join('') + 'tool_response>';
const FC_OPEN = '<' + 'function_calls>';
const FC_CLOSE = '<' + '/' + 'function_calls>';
const INV_OPEN = (n: string) => '<' + `invoke name="${n}">`;
const INV_CLOSE = '<' + '/' + 'invoke>';
const PAR_OPEN = (n: string) => '<' + `parameter name="${n}">`;
const PAR_CLOSE = '<' + '/' + 'parameter>';
const LEG_OPEN = (n: string) => '<' + `function=${n}>`;
const LEG_PAR = (n: string) => '<' + `parameter=${n}>`;
const LEG_PAR_CLOSE = '<' + '/' + 'parameter>';
const LEG_CLOSE = '<' + '/' + 'function>';
const FENCE = '```';

describe('xmlToolParser dialects', () => {
  it('parses the tool_response JSON envelope', () => {
    const text = `ok ${TR_OPEN}{"name":"get_weather","arguments":{"city":"Paris"}}${TR_CLOSE} done`;
    const { text: clean, calls } = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('get_weather');
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ city: 'Paris' });
    expect(clean).toBe('ok  done');
  });

  it('parses the antml-prefixed envelope and arrays', () => {
    const body = JSON.stringify([
      { name: 'a', arguments: { x: 1 } },
      { name: 'b', arguments: { y: 2 } },
    ]);
    const { calls } = extractToolCalls(`${ANT_TR_OPEN}${body}${ANT_TR_CLOSE}`);
    expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('parses function_calls/invoke/parameter XML', () => {
    const text = `${FC_OPEN}${INV_OPEN('search')}${PAR_OPEN('query')}cats${PAR_CLOSE}${INV_CLOSE}${FC_CLOSE}`;
    const { calls } = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('search');
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ query: 'cats' });
  });

  it('parses the legacy function= dialect', () => {
    const text = `${LEG_OPEN('get_weather')}${LEG_PAR('city')}Paris${LEG_PAR_CLOSE}${LEG_CLOSE}`;
    const { calls } = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('get_weather');
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ city: 'Paris' });
  });

  it('parses bare fenced JSON only for declared tools', () => {
    const payload = JSON.stringify({ name: 'get_weather', arguments: { city: 'Rome' } });
    const text = `Calling:\n${FENCE}json\n${payload}\n${FENCE}\nbye`;
    const withTools = extractToolCalls(text, ['get_weather']);
    expect(withTools.calls).toHaveLength(1);
    expect(withTools.text.replace(/\s+/g, ' ').trim()).toBe('Calling: bye');
    const noTools = extractToolCalls(text, []);
    expect(noTools.calls).toHaveLength(0);
    expect(noTools.text).toContain(payload);
  });

  it('streams: split openers and bodies across chunks', () => {
    const parser = new StreamingToolParser();
    const full = `hi ${TR_OPEN}{"name":"t","arguments":{"a":1}}${TR_CLOSE} tail`;
    let out = '';
    const calls = [];
    for (let i = 0; i < full.length; i += 3) {
      const step = parser.push(full.slice(i, i + 3));
      out += step.text;
      calls.push(...step.calls);
    }
    const fin = parser.flush();
    out += fin.text;
    calls.push(...fin.calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('t');
    expect(out).toBe('hi  tail');
  });

  it('does not eat normal prose with braces or angle brackets', () => {
    const { text, calls } = extractToolCalls('if (a < b && c > d) { return {x: 1}; }', ['other_tool']);
    expect(calls).toHaveLength(0);
    expect(text).toBe('if (a < b && c > d) { return {x: 1}; }');
  });

  it('toolNamesFromDefinitions reads both shapes', () => {
    expect(toolNamesFromDefinitions([{ function: { name: 'a' } }, { name: 'b' } as any])).toEqual(['a', 'b']);
  });
});
