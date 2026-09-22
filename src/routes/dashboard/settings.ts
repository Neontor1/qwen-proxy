/**
 * Dashboard page 5/5 — Settings: JSON editor for config.json with validation
 * and live (hot) reload. The editor is Monaco when the CDN is reachable and a
 * hardened plain-text editor otherwise, so the dashboard keeps working on an
 * air-gapped host (the switch happens in `public/app.js`).
 */
import type { Hono } from 'hono';
import { sessionPool } from '../../services/sessionPool.js';
import { getConfig, getConfigRaw, putConfig } from '../config.js';
import { layout } from './layout.js';

export function register(api: Hono): void {
  api.get('/config', (c) => getConfig(c));
  api.get('/config/raw', (c) => getConfigRaw(c));
  api.put('/config', (c) => putConfig(c));
  api.get('/sessions', (c) => c.json(sessionPool.stats()));
}

export const page = layout(
  'settings',
  `
<section class="card">
  <div class="row">
    <h3>config.json</h3>
    <span id="cfg-editor-mode" class="badge">editor: …</span>
    <span class="spacer"></span>
    <button id="cfg-format" class="btn ghost" title="Reformat JSON">Format</button>
    <button id="cfg-reload" class="btn ghost">Reload</button>
    <button id="cfg-save" class="btn primary">Validate &amp; save (live reload)</button>
  </div>
  <div id="cfg-problems" class="error"></div>
  <div id="cfg-monaco" class="monaco-host hidden"></div>
  <textarea id="cfg-editor" class="editor" spellcheck="false"></textarea>
  <p class="muted">
    Changes apply immediately to new requests (hot reload). Monaco is loaded from a CDN when it is
    reachable; offline the built-in editor with JSON validation is used instead. Secrets are stored
    as-is in config.json — protect the file.
  </p>
</section>
`,
);
