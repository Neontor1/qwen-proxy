/**
 * Path utilities — resolves project root, data dir and file locations.
 * Data dir defaults to the project root and can be overridden with QWEN_PROXY_HOME
 * (used by the Docker image and the installers).
 */
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository / installation root (contains package.json). */
export const PROJECT_ROOT = path.resolve(here, '..', '..');

/** Directory for mutable state: config.json, accounts.json, logs/, master.key. */
export function dataDir(): string {
  const override = process.env.QWEN_PROXY_HOME;
  const dir = override?.trim() ? path.resolve(override) : PROJECT_ROOT;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataFile(name: string): string {
  return path.join(dataDir(), name);
}

export const paths = {
  config: () => dataFile('config.json'),
  configExample: () => path.join(PROJECT_ROOT, 'config.example.jsonc'),
  accounts: () => dataFile('accounts.json'),
  sessions: () => dataFile('sessions.json'),
  masterKey: () => dataFile('master.key'),
  logDir: () => {
    const dir = path.join(dataDir(), 'logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  },
  requestLog: () => path.join(paths.logDir(), 'requests.jsonl'),
  systemLog: () => path.join(paths.logDir(), 'system.log'),
  modelsJson: () => path.join(PROJECT_ROOT, 'src', 'models.json'),
  dashboardPublic: () => path.join(PROJECT_ROOT, 'src', 'routes', 'dashboard', 'public'),
  home: () => os.homedir(),
};

/** Ensure a directory exists (recursive), returns the path. */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
