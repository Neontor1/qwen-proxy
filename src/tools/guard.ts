/**
 * Spam / abuse guards for parsed tool calls:
 *  - cap on the number of tool calls per single response
 *  - duplicate-call loop detection (same name+args repeated)
 *  - oversized-arguments rejection
 */
import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const log = createLogger('guard');

export interface GuardedCall {
  name: string;
  arguments: string; // JSON string
}

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

export class ToolGuard {
  private calls: GuardedCall[] = [];
  private hashes = new Map<string, number>();

  constructor(
    private opts: {
      maxCalls?: number;
      maxArgsBytes?: number;
      maxDuplicates?: number;
    } = {},
  ) {}

  allow(call: GuardedCall): GuardDecision {
    const maxCalls = this.opts.maxCalls ?? 8;
    const maxArgsBytes = this.opts.maxArgsBytes ?? 64 * 1024;
    const maxDuplicates = this.opts.maxDuplicates ?? 2;

    if (this.calls.length >= maxCalls) {
      log.warn(`tool guard: rejecting call #${this.calls.length + 1} (max ${maxCalls} per response)`);
      return { allow: false, reason: `too many tool calls in one response (max ${maxCalls})` };
    }
    if (call.arguments.length > maxArgsBytes) {
      return { allow: false, reason: `tool arguments exceed ${maxArgsBytes} bytes` };
    }
    const hash = createHash('sha1').update(`${call.name}::${call.arguments}`).digest('hex').slice(0, 12);
    const seen = (this.hashes.get(hash) ?? 0) + 1;
    this.hashes.set(hash, seen);
    if (seen > maxDuplicates) {
      log.warn(`tool guard: duplicate call detected (${call.name} x${seen}) — suppressing to prevent loops`);
      return {
        allow: false,
        reason: `duplicate tool call "${call.name}" repeated ${seen} times (loop guard)`,
      };
    }
    this.calls.push(call);
    return { allow: true };
  }

  get count(): number {
    return this.calls.length;
  }
}
