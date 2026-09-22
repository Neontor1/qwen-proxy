import { createLogger } from '../utils/logger.js';
/**
 * Qwen provider abstraction.
 *
 * Two implementations:
 *  - MockQwenProvider  — deterministic in-process simulator (tests, demos, offline dev)
 *  - RealQwenProvider  — talks to chat.qwen.ai (HTTP auth + SSE chat flow)
 *
 * Selection: config PROVIDER = auto | real | mock.
 *   auto → real if at least one account is configured, else mock.
 */
import { configService } from './configService.js';
import { MockQwenProvider } from './mockProvider.js';
import { RealQwenProvider } from './realProvider.js';

const log = createLogger('provider');

/** Auth tokens obtained from login/refresh. */
export interface AuthTokens {
  token: string;
  refreshToken?: string;
  /** epoch ms when the token expires (0 = unknown) */
  expiresAt: number;
  /** extra cookies captured from a browser login, if any */
  cookies?: string;
}

/** A live authenticated session bound to one account. */
export interface QwenSession {
  accountId: string;
  email: string;
  tokens: AuthTokens;
  createdAt: number;
  lastUsed: number;
}

export interface ToolDefinition {
  type?: string;
  function?: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
  /** allow flat shape too */
  name?: string;
  description?: string;
  parameters?: unknown;
}

export interface ChatRequestParams {
  /** concrete (routed) model id */
  model: string;
  /** fully rendered prompt text (system + history + last user message) */
  prompt: string;
  /** original OpenAI messages (kept for mock realism / future multimodal) */
  messages: Array<{ role: string; content: unknown }>;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  enableSearch?: boolean;
  thinkingEnabled?: boolean;
  signal?: AbortSignal;
}

export type QwenStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }
  | { type: 'finish'; reason: string }
  | { type: 'error'; error: QwenError };

/** Structured upstream error with classification for failover decisions. */
export class QwenError extends Error {
  status: number;
  code?: string;
  /** 429 / risk control / quota — account should cool down */
  rateLimited: boolean;
  /** 401/403 token issues — session should refresh or re-login */
  authFailed: boolean;
  /** worth retrying on another account */
  retryable: boolean;

  constructor(
    message: string,
    opts: {
      status?: number;
      code?: string;
      rateLimited?: boolean;
      authFailed?: boolean;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'QwenError';
    this.status = opts.status ?? 502;
    this.code = opts.code;
    this.rateLimited = opts.rateLimited ?? false;
    this.authFailed = opts.authFailed ?? false;
    this.retryable = opts.retryable ?? (this.rateLimited || this.status >= 500 || this.status === 0);
  }
}

export interface QwenProvider {
  readonly kind: 'real' | 'mock';
  login(email: string, password: string): Promise<AuthTokens>;
  /**
   * Cheap liveness check for an existing session (used by cookie accounts,
   * which have no password to re-login with): `POST /accounts/:id/test`.
   */
  probe(tokens: AuthTokens): Promise<{ ok: boolean; message: string }>;
  refresh(tokens: AuthTokens, email: string): Promise<AuthTokens>;
  listModels(session?: QwenSession | null): Promise<Array<{ id: string; name?: string }>>;
  streamChat(session: QwenSession, params: ChatRequestParams): AsyncGenerator<QwenStreamEvent>;
}

let cachedProvider: QwenProvider | null = null;
let cachedKind: string | null = null;

export function getProvider(): QwenProvider {
  const cfg = configService.get();
  const mode = cfg.PROVIDER;
  const effective = mode === 'auto' ? (accountCount() > 0 ? 'real' : 'mock') : mode;
  // "auto" must re-evaluate: accounts can appear after startup
  if (cachedProvider && cachedKind === effective && mode !== 'auto') return cachedProvider;
  if (cachedProvider && cachedKind === effective && mode === 'auto') return cachedProvider;
  cachedKind = effective;
  cachedProvider = effective === 'mock' ? new MockQwenProvider() : new RealQwenProvider();
  log.info(`provider selected: ${effective}${mode === 'auto' ? ' (auto)' : ''}`);
  return cachedProvider;
}

/** Reset the memoized provider (used by tests / config hot-reload). */
export function resetProvider(): void {
  cachedProvider = null;
  cachedKind = null;
}

/** Lazy import to avoid a circular dependency (accountManager imports provider). */
let accountCountFn: () => number = () => 0;
export function registerAccountCounter(fn: () => number): void {
  accountCountFn = fn;
}
function accountCount(): number {
  return accountCountFn();
}
