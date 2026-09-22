#!/usr/bin/env node
/**
 * qg launcher: prefers Bun (fast TS execution), falls back to Node + tsx.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.ts');
const args = process.argv.slice(2);

function commandExists(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, cmdArgs) {
  const child = spawn(cmd, cmdArgs, { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error(`qg: failed to start ${cmd}: ${err.message}`);
    process.exit(1);
  });
}

if (commandExists('bun')) {
  run('bun', [cli, ...args]);
} else {
  const tsxBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  if (existsSync(tsxBin)) {
    run(tsxBin, [cli, ...args]);
  } else if (commandExists('npx')) {
    run('npx', ['tsx', cli, ...args]);
  } else {
    console.error('qg: neither Bun nor tsx found. Install Bun: https://bun.sh (or run: npm i)');
    process.exit(1);
  }
}
