/**
 * Shared dashboard shell: navigation + HTML layout used by all five pages.
 */

export const NAV = [
  ['overview', '/dashboard', 'Overview'],
  ['accounts', '/dashboard/accounts', 'Accounts'],
  ['logs', '/dashboard/logs', 'Logs'],
  ['network', '/dashboard/network', 'Network'],
  ['settings', '/dashboard/settings', 'Settings'],
] as const;

export type PageId = (typeof NAV)[number][0];

const FAVICON = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#7c3aed"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="white" font-family="monospace">Q</text></svg>',
);

/**
 * Render the page shell.
 * @param extraHead  additional `<head>` markup (e.g. the Monaco loader on Settings)
 */
export function layout(page: PageId, body: string, extraHead = ''): string {
  const nav = NAV.map(
    ([id, href, label]) => `<a class="nav ${id === page ? 'active' : ''}" href="${href}">${label}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Qwen Proxy Gateway — ${page}</title>
<link rel="icon" href="data:image/svg+xml,${FAVICON}"/>
<link rel="stylesheet" href="/dashboard/public/style.css"/>
${extraHead}
</head>
<body data-page="${page}">
<header class="topbar">
  <div class="brand"><span class="logo">Q</span> Qwen Proxy Gateway</div>
  <nav>${nav}</nav>
  <div class="topbar-right">
    <span id="provider-badge" class="badge">…</span>
    <button id="logout-btn" class="btn ghost" title="Clear dashboard session">exit</button>
  </div>
</header>
<main id="app">${body}</main>
<div id="login-overlay" class="overlay hidden">
  <form id="login-form" class="card login-card">
    <h2>Master key required</h2>
    <p class="muted">Enter the MASTER_KEY from your config to manage the gateway.</p>
    <input type="password" id="login-key" placeholder="Master key" autocomplete="off"/>
    <div class="row"><button class="btn primary" type="submit">Unlock</button><span id="login-error" class="error"></span></div>
  </form>
</div>
<div id="toast" class="toast hidden"></div>
<script src="/dashboard/public/app.js"></script>
</body>
</html>`;
}
