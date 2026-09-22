/**
 * Hono application assembly — all routes, middleware and the dashboard.
 */
import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { bearerAuth, masterAuth } from './middleware/auth.js';
import { cors } from './middleware/cors.js';
import { rateLimit } from './middleware/rateLimit.js';
import {
  addAccount,
  listAccounts,
  patchAccount,
  removeAccount,
  testAccount,
  verifyCookies,
} from './routes/accounts.js';
import { handleChatCompletions } from './routes/chat.js';
import { dashboard } from './routes/dashboard/index.js';
import { handleHealth } from './routes/health.js';
import { handleAnthropicCountTokens, handleAnthropicMessages } from './routes/messages.js';
import { handleModels } from './routes/models.js';
import {
  fixClaudePs1,
  installClaudePs1,
  installClaudeSh,
  setupClaudeCode,
  setupCursor,
  setupOpencode,
} from './routes/setup.js';
import { captureProxy, rootApiCaptureProxy } from './services/captureProxy.js';
import { configService } from './services/configService.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('app');

export function buildApp(): Hono {
  const app = new Hono();

  app.use('*', cors());
  // `/dashboard/` and `/dashboard` must behave identically (browsers & humans
  // type trailing slashes); canonicalise once, early.
  app.use('*', trimTrailingSlash());

  // ── public: root & health ──
  app.get('/', (c) =>
    c.json({
      service: 'qwen-proxy-gateway',
      version: '1.0.0',
      dashboard: `${configService.publicUrl()}/dashboard`,
      endpoints: [
        '/v1/chat/completions',
        '/v1/messages',
        '/v1/messages/count_tokens',
        '/v1/models',
        '/health',
        '/setup/claude-code',
      ],
    }),
  );
  app.get('/ping', (c) => handleHealth(c));
  app.get('/health', (c) => handleHealth(c));

  // ── OpenAI-compatible API ──
  app.use('/v1/*', rateLimit());
  app.use('/v1/*', bearerAuth());
  app.post('/v1/chat/completions', (c) => handleChatCompletions(c));
  // Anthropic Messages API — what Claude Code actually calls
  app.post('/v1/messages', (c) => handleAnthropicMessages(c));
  app.post('/v1/messages/count_tokens', (c) => handleAnthropicCountTokens(c));
  app.get('/v1/models', (c) => handleModels(c));

  // ── capture-link login portal (public login surface, ticket-scoped) ──
  app.all('/api/*', rootApiCaptureProxy());
  app.route('/qwen', captureProxy);

  // ── client setup helpers (public; contain no secrets beyond the API key) ──
  app.get('/setup/claude-code', (c) => setupClaudeCode(c));
  app.get('/setup/opencode', (c) => setupOpencode(c));
  app.get('/setup/cursor', (c) => setupCursor(c));
  app.get('/install/claude.ps1', (c) => installClaudePs1(c));
  app.get('/install/fix-claude.ps1', (c) => fixClaudePs1(c));
  app.get('/install/claude.sh', (c) => installClaudeSh(c));

  // ── account management API (master key) ──
  app.use('/accounts*', masterAuth());
  app.get('/accounts', (c) => listAccounts(c));
  app.post('/accounts', (c) => addAccount(c));
  app.post('/accounts/verify', (c) => verifyCookies(c));
  app.delete('/accounts/:id', (c) => removeAccount(c));
  app.patch('/accounts/:id', (c) => patchAccount(c));
  app.post('/accounts/:id/test', (c) => testAccount(c));

  // ── dashboard ──
  app.route('/dashboard', dashboard);

  app.notFound((c) =>
    c.json(
      { error: { message: `Not found: ${c.req.method} ${c.req.path}`, type: 'invalid_request_error' } },
      404,
    ),
  );

  app.onError((err, c) => {
    log.error(`unhandled error on ${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: { message: 'Internal server error', type: 'api_error' } }, 500);
  });

  return app;
}
