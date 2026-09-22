import { randomBytes } from 'node:crypto';
/**
 * Config service — loads config.json (creating it from defaults on first run),
 * overlays environment variables, validates with Zod, supports live updates
 * from the dashboard (hot reload) and emits change events.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { paths } from '../utils/paths.js';

const log = createLogger('config');

const boolStr = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const numLike = z
  .union([z.number(), z.string()])
  .transform((v) => {
    if (typeof v === 'number') return v;
    const parsed = Number.parseInt(v, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });

export const ConfigSchema = z.object({
  PORT: z.union([z.number(), z.string()]).transform((v) => {
    const parsed = Number(v);
    return Number.isNaN(parsed) ? 26405 : parsed;
  }),
  HOST: z.string().default('0.0.0.0'),
  /** When the configured port is busy / OS-excluded, pick the next free one. */
  PORT_AUTO_FALLBACK: boolStr.default(true),
  API_KEY: z.string().default(''),
  MASTER_KEY: z.string().default(''),

  PROVIDER: z.enum(['auto', 'real', 'mock']).default('auto'),
  QWEN_BASE_URL: z.string().default('https://chat.qwen.ai'),
  BROWSER: z.enum(['chromium', 'firefox', 'webkit', 'chrome', 'edge']).default('chromium'),
  BROWSER_LOGIN: boolStr.default(false),
  SESSION_POOL_SIZE: numLike.default(5),

  TOOL_CALLING: boolStr.default(true),
  CLEAN_OUTPUT: boolStr.default(true),
  STREAMING_MODE: z.enum(['auto', 'on', 'off']).default('auto'),
  RATE_LIMIT_COOLDOWN_MS: numLike.default(120_000),
  RETRY_MAX_ATTEMPTS: numLike.default(3),
  HEARTBEAT_INTERVAL_MS: numLike.default(15_000),
  STREAM_IDLE_TIMEOUT_MS: numLike.default(120_000),
  MAX_ACCOUNT_ERRORS: numLike.default(5),

  RATE_LIMIT_ENABLED: boolStr.default(true),
  RATE_LIMIT_RPM: numLike.default(60),
  RATE_LIMIT_BURST: numLike.default(20),

  /**
   * Reject unknown model ids with 400 instead of silently routing them to the
   * default model. When false (default) the fallback is kept for client
   * compatibility but advertised via the X-Model-Routed-From response header.
   */
  STRICT_MODELS: boolStr.default(false),
  /** Seed a throwaway demo account when the mock provider has nothing to serve. */
  MOCK_DEMO_ACCOUNT: boolStr.default(true),

  SAVE_REQUEST_LOGS: boolStr.default(false),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NETWORK_DEBUG: boolStr.default(false),
  LOG_BUFFER_SIZE: numLike.default(500),

  OPEN_DASHBOARD_ON_START: boolStr.default(false),
  WORKERS: numLike.default(1),
  PUBLIC_URL: z.string().default(''),

  ACCOUNTS: z.array(z.object({ email: z.string(), password: z.string() })).default([]),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Raw JSON shape as stored on disk (before transforms). */
type RawConfig = Partial<Record<string, unknown>>;

const DEFAULTS: RawConfig = {
  PORT: '26405',
  HOST: '0.0.0.0',
  API_KEY: '',
  BROWSER: 'chromium',
  TOOL_CALLING: true,
  CLEAN_OUTPUT: true,
  STREAMING_MODE: 'auto',
  RATE_LIMIT_COOLDOWN_MS: 120000,
  RETRY_MAX_ATTEMPTS: 3,
  HEARTBEAT_INTERVAL_MS: 15000,
  SESSION_POOL_SIZE: 5,
  SAVE_REQUEST_LOGS: false,
  OPEN_DASHBOARD_ON_START: false,
  ACCOUNTS: [],
};

const ENV_KEYS = Object.keys(ConfigSchema.shape) as (keyof AppConfig)[];

type ChangeListener = (config: AppConfig, prev: AppConfig) => void;

class ConfigService {
  private current: AppConfig | null = null;
  private raw: RawConfig = {};
  private listeners: ChangeListener[] = [];
  private masterKeyCache: string | null = null;

  /** Load (or create) config.json, apply env overrides, validate. Idempotent. */
  load(force = false): AppConfig {
    if (this.current && !force) return this.current;
    const file = paths.config();
    let fileRaw: RawConfig = {};
    if (existsSync(file)) {
      try {
        fileRaw = JSON.parse(readFileSync(file, 'utf8')) as RawConfig;
      } catch (err) {
        log.error(`config.json is corrupt, falling back to defaults: ${String(err)}`);
      }
    } else {
      fileRaw = { ...DEFAULTS };
      writeFileSync(file, `${JSON.stringify(fileRaw, null, 2)}\n`, 'utf8');
      log.info(`created default config at ${file}`);
    }
    this.raw = fileRaw;
    const merged = this.applyEnv(fileRaw);
    const parsed = ConfigSchema.safeParse(merged);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      log.error(`config validation failed (${issues}) — using defaults for invalid keys`);
      const fallback = ConfigSchema.parse({ ...DEFAULTS });
      this.current = { ...fallback, ...stripInvalid(merged, parsed.error) } as AppConfig;
    } else {
      this.current = parsed.data;
    }
    return this.current;
  }

  get(): AppConfig {
    return this.current ?? this.load();
  }

  /**
   * Runtime-only override (never persisted): the server adopts the port it
   * actually bound to, so PUBLIC_URL, the banner and /setup/* links stay right.
   */
  adoptPort(port: number): void {
    this.current = { ...this.get(), PORT: port };
  }

  /** Live update from the dashboard/CLI: validates, persists, notifies. */
  update(patch: RawConfig): AppConfig {
    const prev = this.get();
    const nextRaw = { ...this.raw, ...patch };
    const merged = this.applyEnv(nextRaw);
    const parsed = ConfigSchema.parse(merged); // throws with a helpful message on invalid input
    this.raw = nextRaw;
    writeFileSync(paths.config(), `${JSON.stringify(nextRaw, null, 2)}\n`, 'utf8');
    this.current = parsed;
    for (const l of this.listeners) {
      try {
        l(parsed, prev);
      } catch (err) {
        log.error('config change listener failed', String(err));
      }
    }
    log.info('configuration updated (hot reload)', Object.keys(patch).join(', '));
    return parsed;
  }

  /** Raw file content for the settings editor. */
  rawFileContent(): string {
    const file = paths.config();
    if (existsSync(file)) return readFileSync(file, 'utf8');
    return `${JSON.stringify(this.raw, null, 2)}\n`;
  }

  /** Validate arbitrary JSON text as a config file. Returns error messages or null. */
  validateText(text: string): string[] | null {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      return [`Invalid JSON: ${String(err)}`];
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return ['Config must be a JSON object'];
    }
    const res = ConfigSchema.safeParse(obj);
    if (!res.success) {
      return res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    }
    return null;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Master key for password encryption: from config, or auto-generated & persisted. */
  masterKey(): string {
    if (this.masterKeyCache) return this.masterKeyCache;
    const cfg = this.get();
    if (cfg.MASTER_KEY) {
      this.masterKeyCache = cfg.MASTER_KEY;
      return this.masterKeyCache;
    }
    const file = paths.masterKey();
    if (existsSync(file)) {
      const key = readFileSync(file, 'utf8').trim();
      if (key) {
        this.masterKeyCache = key;
        return key;
      }
    }
    const key = randomBytes(24).toString('hex');
    writeFileSync(file, key, { mode: 0o600 });
    this.masterKeyCache = key;
    log.warn(`no MASTER_KEY configured — generated one at ${file} (keep it safe; dashboard access uses it)`);
    return key;
  }

  /** Base URL this server is reachable at (for generated setup scripts). */
  publicUrl(): string {
    const cfg = this.get();
    if (cfg.PUBLIC_URL) return cfg.PUBLIC_URL.replace(/\/$/, '');
    const host = cfg.HOST === '0.0.0.0' || cfg.HOST === '::' ? 'localhost' : cfg.HOST;
    return `http://${host}:${cfg.PORT}`;
  }

  private applyEnv(fileRaw: RawConfig): RawConfig {
    const merged: RawConfig = { ...fileRaw };
    for (const key of ENV_KEYS) {
      const envVal = process.env[key] ?? process.env[`QP_${key}`];
      if (envVal !== undefined && envVal !== '') merged[key] = envVal;
    }
    return merged;
  }
}

/** Keep the valid subset of an object given a ZodError, drop invalid keys. */
function stripInvalid(obj: RawConfig, error: z.ZodError): RawConfig {
  const badPaths = new Set(error.issues.map((i) => String(i.path[0] ?? '')));
  const out: RawConfig = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!badPaths.has(k)) out[k] = v;
  }
  return out;
}

export const configService = new ConfigService();
