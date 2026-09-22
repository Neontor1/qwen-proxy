/**
 * Model catalog — loads src/models.json, merges in models discovered from the
 * upstream Qwen API (real provider) and exposes lookups for the router.
 */
import { readFileSync } from 'node:fs';
import { createLogger } from '../utils/logger.js';
import { paths } from '../utils/paths.js';

const log = createLogger('models');

export interface ModelDefinition {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  supportsThinking?: boolean;
  supportsSearch?: boolean;
  chatType?: string;
  aliases?: string[];
  fallback?: string | null;
  default?: boolean;
  /** discovered from upstream at runtime */
  upstream?: boolean;
}

interface ModelsFile {
  models: ModelDefinition[];
  defaultFallbackChain: string[];
}

class QwenModels {
  private catalog: ModelDefinition[] = [];
  private fallbackChain: string[] = [];
  private byId = new Map<string, ModelDefinition>();
  private byAlias = new Map<string, string>();
  private upstreamIds = new Set<string>();

  constructor() {
    this.loadStatic();
  }

  private loadStatic(): void {
    try {
      const raw = readFileSync(paths.modelsJson(), 'utf8');
      const parsed = JSON.parse(raw) as ModelsFile;
      this.catalog = parsed.models ?? [];
      this.fallbackChain = parsed.defaultFallbackChain ?? [];
      this.reindex();
    } catch (err) {
      log.error(`failed to load models.json: ${String(err)}`);
      this.catalog = [];
    }
  }

  private reindex(): void {
    this.byId.clear();
    this.byAlias.clear();
    for (const m of this.catalog) {
      this.byId.set(m.id.toLowerCase(), m);
      for (const a of m.aliases ?? []) this.byAlias.set(a.toLowerCase(), m.id);
    }
  }

  /** Merge models reported by the live Qwen API (adds unknown ones). */
  mergeUpstream(upstream: Array<{ id: string; name?: string }>): void {
    let added = 0;
    for (const u of upstream) {
      const id = (u.id ?? '').trim();
      if (!id) continue;
      this.upstreamIds.add(id);
      const existing = this.byId.get(id.toLowerCase());
      if (existing) {
        existing.upstream = true;
        continue;
      }
      this.catalog.push({
        id,
        name: u.name ?? id,
        upstream: true,
        chatType: 't2t',
        fallback: this.fallbackChain[0] ?? null,
      });
      added++;
    }
    if (added > 0) {
      this.reindex();
      log.info(`merged ${added} upstream model(s) into catalog`);
    }
  }

  all(): ModelDefinition[] {
    return [...this.catalog].sort(
      (a, b) => Number(!!b.default) - Number(!!a.default) || a.id.localeCompare(b.id),
    );
  }

  get(idOrAlias: string): ModelDefinition | undefined {
    const key = idOrAlias.toLowerCase().trim();
    const direct = this.byId.get(key);
    if (direct) return direct;
    const mapped = this.byAlias.get(key);
    return mapped ? this.byId.get(mapped.toLowerCase()) : undefined;
  }

  has(idOrAlias: string): boolean {
    return this.get(idOrAlias) !== undefined;
  }

  defaultModel(): ModelDefinition {
    return this.catalog.find((m) => m.default) ?? this.catalog[0] ?? { id: 'qwen3-max', name: 'Qwen3-Max' };
  }

  /** Ordered fallback chain for a model: itself → explicit fallback → global chain. */
  fallbackChainFor(idOrAlias: string): string[] {
    const model = this.get(idOrAlias);
    const chain: string[] = [];
    if (model) chain.push(model.id);
    if (model?.fallback && model.fallback !== model.id) chain.push(model.fallback);
    for (const f of this.fallbackChain) if (!chain.includes(f)) chain.push(f);
    return chain.length ? chain : [this.defaultModel().id];
  }
}

export const qwenModels = new QwenModels();
