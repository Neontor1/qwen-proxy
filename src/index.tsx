/**
 * Main Hono server module (spec: src/index.tsx).
 * Export the app for embedding/tests; when executed directly, start it.
 */
import { buildApp } from './app.js';
import { maybeOpenDashboard, startGateway } from './bootstrap.js';
import { configService } from './services/configService.js';

export const app = buildApp();
export default app;

const argv1 = process.argv[1] ?? '';
const isMain = (import.meta as unknown as { main?: boolean }).main === true || /index\.tsx?$/.test(argv1);

if (isMain) {
  configService.load();
  void startGateway(app).then(() => {
    if (configService.get().OPEN_DASHBOARD_ON_START) maybeOpenDashboard();
  });
}
