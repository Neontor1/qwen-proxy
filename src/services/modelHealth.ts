/**
 * Model health tracking — each model starts "unknown", becomes "healthy" on
 * success, "degraded" after isolated errors, "down" after consecutive
 * failures or while all accounts backing it are in cooldown.
 */
import { createLogger } from '../utils/logger.js';
import { qwenModels } from './qwenModels.js';

const log = createLogger('modelHealth');

export type ModelHealthState = 'healthy' | 'degraded' | 'down' | 'unknown';

interface ModelHealth {
  state: ModelHealthState;
  consecutiveErrors: number;
  totalRequests: number;
  totalErrors: number;
  lastSuccess: number | null;
  lastError: number | null;
  lastErrorMessage: string | null;
  downUntil: number | null;
}

const DEGRADED_AFTER = 1;
const DOWN_AFTER = 3;
const DOWN_COOLDOWN_MS = 60_000;

class ModelHealthTracker {
  private health = new Map<string, ModelHealth>();

  private entry(model: string): ModelHealth {
    let h = this.health.get(model);
    if (!h) {
      h = {
        state: 'unknown',
        consecutiveErrors: 0,
        totalRequests: 0,
        totalErrors: 0,
        lastSuccess: null,
        lastError: null,
        lastErrorMessage: null,
        downUntil: null,
      };
      this.health.set(model, h);
    }
    return h;
  }

  recordSuccess(model: string): void {
    const h = this.entry(model);
    h.consecutiveErrors = 0;
    h.totalRequests++;
    h.lastSuccess = Date.now();
    h.state = 'healthy';
    h.downUntil = null;
  }

  recordError(model: string, message: string, isRateLimit = false): void {
    const h = this.entry(model);
    h.consecutiveErrors++;
    h.totalRequests++;
    h.totalErrors++;
    h.lastError = Date.now();
    h.lastErrorMessage = message.slice(0, 500);
    if (h.consecutiveErrors >= DOWN_AFTER || isRateLimit) {
      h.state = 'down';
      h.downUntil = Date.now() + (isRateLimit ? DOWN_COOLDOWN_MS * 2 : DOWN_COOLDOWN_MS);
      log.warn(`model ${model} marked DOWN (rateLimit=${isRateLimit}, consecutive=${h.consecutiveErrors})`);
    } else if (h.consecutiveErrors >= DEGRADED_AFTER) {
      h.state = 'degraded';
    }
  }

  /** Effective state, taking the down-cooldown expiry into account. */
  stateOf(model: string): ModelHealthState {
    const h = this.health.get(model);
    if (!h) return 'unknown';
    if (h.state === 'down' && h.downUntil && Date.now() > h.downUntil) return 'degraded';
    return h.state;
  }

  isAvailable(model: string): boolean {
    const state = this.stateOf(model);
    return state !== 'down';
  }

  /**
   * Pick the first available model from the router's fallback chain.
   * Returns null if every candidate is down (caller should still try the
   * first one — better an attempt than a hard failure).
   */
  pickAvailable(chain: string[]): string {
    for (const m of chain) if (this.isAvailable(m)) return m;
    return chain[0] ?? qwenModels.defaultModel().id;
  }

  snapshot(): Record<string, ModelHealth> {
    const out: Record<string, ModelHealth> = {};
    for (const id of qwenModels.all().map((m) => m.id)) {
      const h = this.health.get(id);
      out[id] = h ? { ...h, state: this.stateOf(id) } : { ...this.entry(id) };
    }
    for (const [id, h] of this.health) {
      if (!out[id]) out[id] = { ...h, state: this.stateOf(id) };
    }
    return out;
  }

  reset(model?: string): void {
    if (model) this.health.delete(model);
    else this.health.clear();
  }
}

export const modelHealth = new ModelHealthTracker();
