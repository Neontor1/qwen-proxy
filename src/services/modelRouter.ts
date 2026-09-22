/**
 * Model router — resolves a requested (possibly aliased) model to a concrete
 * Qwen model id and produces a health-aware fallback chain.
 */
import { createLogger } from '../utils/logger.js';
import { modelHealth } from './modelHealth.js';
import { qwenModels } from './qwenModels.js';

const log = createLogger('router');

export interface RoutingDecision {
  /** model id actually sent upstream */
  resolved: string;
  /** what the client asked for */
  requested: string;
  /** true when an alias was mapped to a different id */
  aliased: boolean;
  /** full ordered fallback chain (resolved first) */
  chain: string[];
}

class ModelRouter {
  resolve(requested: string | undefined | null): RoutingDecision {
    const req = (requested ?? '').trim();
    const def = req ? qwenModels.get(req) : qwenModels.defaultModel();
    const resolved = def?.id ?? qwenModels.defaultModel().id;
    const chain = this.buildChain(resolved);
    const first = chain[0] ?? resolved;
    if (first !== resolved) {
      log.debug(`routing ${resolved} → ${first} (health fallback)`);
    }
    return {
      resolved: first,
      requested: req || resolved,
      aliased: !!def && req.toLowerCase() !== resolved.toLowerCase(),
      chain,
    };
  }

  /** Chain ordered by health: available models first, down models last. */
  private buildChain(modelId: string): string[] {
    const chain = qwenModels.fallbackChainFor(modelId);
    const available = chain.filter((m) => modelHealth.isAvailable(m));
    const down = chain.filter((m) => !modelHealth.isAvailable(m));
    return [...available, ...down];
  }

  /** All models exposed via GET /v1/models (OpenAI shape). */
  listForOpenAI(): Array<{ id: string; object: string; created: number; owned_by: string }> {
    return qwenModels.all().map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'qwen',
    }));
  }

  /**
   * Same list PLUS the external alias ids (claude-*, gpt-*). Claude Code and
   * friends validate the chosen model against GET /v1/models before chatting;
   * without the alias rows they refuse names like claude-sonnet-4-5 even though
   * the gateway would route them fine.
   */
  listWithAliases(): Array<{ id: string; object: string; created: number; owned_by: string }> {
    const rows = this.listForOpenAI();
    const seen = new Set(rows.map((r) => r.id));
    for (const m of qwenModels.all()) {
      for (const alias of m.aliases ?? []) {
        if (!/^(claude|gpt)-/.test(alias)) continue; // only client-catalog families
        if (seen.has(alias)) continue;
        seen.add(alias);
        rows.push({ id: alias, object: 'model', created: 1700000000, owned_by: `qwen-alias:${m.id}` });
      }
    }
    return rows;
  }
}

export const modelRouter = new ModelRouter();
