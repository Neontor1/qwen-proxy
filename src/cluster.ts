/**
 * Multi-core support: when config WORKERS > 1 the primary process forks
 * worker processes via node:cluster (Node ≥ 20; Bun best-effort — falls back
 * to single-process with a warning when unsupported).
 */
import cluster from 'node:cluster';
import os from 'node:os';
import { configService } from './services/configService.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('cluster');

export function clusterWorkersRequested(): number {
  const w = Number(configService.get().WORKERS) || 1;
  return w === -1 ? os.availableParallelism() : w;
}

function clusterSupported(): boolean {
  return typeof (cluster as any).isPrimary === 'boolean' && typeof (cluster as any).fork === 'function';
}

/** Runs main() either directly or inside cluster workers. */
export async function runWithCluster(main: () => Promise<void>): Promise<void> {
  const workers = clusterWorkersRequested();
  if (workers <= 1) return main();
  if (!clusterSupported()) {
    log.warn('node:cluster unsupported by this runtime — running single-process');
    return main();
  }
  if ((cluster as any).isPrimary) {
    const n = Math.min(workers, os.availableParallelism());
    log.info(`cluster primary pid=${process.pid}, forking ${n} workers`);
    for (let i = 0; i < n; i++) (cluster as any).fork();
    (cluster as any).on('exit', (worker: any) => {
      log.warn(`worker ${worker.process.pid} died, restarting`);
      (cluster as any).fork();
    });
    return;
  }
  log.info(`cluster worker pid=${process.pid} started`);
  return main();
}
