/* Qwen Proxy Gateway — dashboard frontend (vanilla JS, no build step) */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const page = document.body.dataset.page;
  const masterKey = sessionStorage.getItem('qg_master') || '';

  // ── helpers ──────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString();
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${isErr ? ' err' : ''}`;
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (masterKey) headers['X-Master-Key'] = masterKey;
    const res = await fetch(`/dashboard/api${path}`, { ...opts, headers, credentials: 'same-origin' });
    if (res.status === 401) {
      showLogin();
      throw new Error('unauthorized');
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(data?.error || data?.problems?.join('; ') || res.statusText);
    return data;
  }

  // ── login overlay ────────────────────────────────────────────────────────
  function showLogin() {
    $('#login-overlay').classList.remove('hidden');
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('#login-key').value;
    try {
      const res = await fetch('/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) throw new Error('Invalid master key');
      sessionStorage.setItem('qg_master', key);
      location.reload();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });
  $('#logout-btn').addEventListener('click', () => {
    sessionStorage.removeItem('qg_master');
    location.reload();
  });

  // ── SSE stream ───────────────────────────────────────────────────────────
  let es = null;
  function connectStream(handlers) {
    const url = masterKey
      ? `/dashboard/api/stream?key=${encodeURIComponent(masterKey)}`
      : '/dashboard/api/stream';
    es = new EventSource(url, { withCredentials: true });
    es.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.kind === 'request' && handlers.request) handlers.request(msg.entry);
      if (msg.kind === 'system' && handlers.system) handlers.system(msg.rec);
    };
    es.onerror = () => {
      // EventSource auto-reconnects; on 401 it keeps retrying → show login
      if (es.readyState === EventSource.CLOSED) showLogin();
    };
  }

  // ── overview ─────────────────────────────────────────────────────────────
  async function renderOverview() {
    const data = await api('/overview');
    $('#provider-badge').textContent = `provider: ${data.provider}`;
    const m = data.metrics;
    $('#kpis').innerHTML = `
      <div class="kpi"><div class="value">${m.requestsPerMin}</div><div class="label">requests / min</div></div>
      <div class="kpi ${m.successRate >= 95 ? 'ok' : m.successRate >= 80 ? 'warn' : 'err'}"><div class="value">${m.successRate}%</div><div class="label">success rate (5m)</div></div>
      <div class="kpi"><div class="value">${m.avgLatencyMs}ms</div><div class="label">avg latency</div></div>
      <div class="kpi"><div class="value">${m.p95LatencyMs}ms</div><div class="label">p95 latency</div></div>
      <div class="kpi ${data.accounts.active ? 'ok' : 'err'}"><div class="value">${data.accounts.active}/${data.accounts.total}</div><div class="label">active accounts</div></div>
      <div class="kpi"><div class="value">${m.inflight}</div><div class="label">in-flight</div></div>`;

    const health = Object.entries(data.modelHealth || {})
      .map(
        ([id, h]) => `
        <div class="row" style="justify-content:space-between;padding:4px 0">
          <span class="mono">${esc(id)}</span>
          <span>
            <span class="status ${esc(h.state)}">${esc(h.state)}</span>
            <span class="muted mono" style="margin-left:8px">${h.totalRequests} req / ${h.totalErrors} err</span>
          </span>
        </div>`,
      )
      .join('');
    $('#model-health').innerHTML = health || '<span class="muted">no data yet</span>';

    const s = data.sessions;
    $('#sessions-box').innerHTML = `
      <div class="row" style="justify-content:space-between"><span>Session pool</span><span class="mono">${s.size}/${s.max}</span></div>
      <div class="row" style="justify-content:space-between"><span>Requests total</span><span class="mono">${m.totalRequests}</span></div>
      <div class="row" style="justify-content:space-between"><span>Errors total</span><span class="mono">${m.totalErrors}</span></div>
      <div class="row" style="justify-content:space-between"><span>Tokens served</span><span class="mono">${m.totalTokens}</span></div>
      <div class="row" style="justify-content:space-between"><span>Uptime</span><span class="mono">${Math.floor(m.uptimeSec / 60)}m ${m.uptimeSec % 60}s</span></div>
      <div class="row" style="justify-content:space-between"><span>Public URL</span><span class="mono">${esc(data.publicUrl)}</span></div>`;

    renderSparkline(m.window.perMin);
    renderSyslog(data.systemLogs || []);
  }

  function renderSparkline(perMin) {
    const max = Math.max(1, ...perMin.map((p) => p.count));
    $('#sparkline').innerHTML = perMin.length
      ? `<div class="spark">${perMin
          .map(
            (p) =>
              `<div class="bar ${p.errors ? 'err' : ''}" title="${new Date(p.ts).toLocaleTimeString()}: ${p.count} req, ${p.errors} err" style="height:${Math.max(6, (p.count / max) * 100)}%"></div>`,
          )
          .join('')}</div>`
      : '<span class="muted">no traffic in the last 5 minutes</span>';
  }

  function syslogLine(rec) {
    return `<span class="${esc(rec.level)}">${fmtTime(rec.ts)} [${esc(rec.scope)}] ${esc(rec.message)}</span>\n`;
  }
  function renderSyslog(logs) {
    const box = $('#syslog');
    box.innerHTML = logs.map(syslogLine).join('') || '';
    box.scrollTop = box.scrollHeight;
  }

  // ── accounts: three onboarding flows + smart table ───────────────────────
  const REQUIRED_COOKIES = ['cna', 'token', 'ssxmod_itna', 'ssxmod_itna2'];
  const RECOMMENDED_COOKIES = ['isg', 'tfstk', 'atpsida', 'aui', 'cnaui', 'sca'];
  const QWEN_DOMAIN_RE = /(^|\.)qwen\.ai$/i;
  const SHARED_DOMAIN_RE =
    /(^|\.)alibaba\.(com|net)$|(^|\.)aliyun\.com$|(^|\.)taobao\.com$|(^|\.)mmstat\.com$/i;
  let accountsCache = [];
  let pendingCookieAccountId = null; // set when re-importing cookies for an existing account
  let linkPoll = null;

  $('#add-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (btn) switchTab(btn.dataset.tab);
  });
  function switchTab(name) {
    document
      .querySelectorAll('#add-tabs .seg')
      .forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document
      .querySelectorAll('.tab-pane')
      .forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }

  // ── instant client-side cookie parsing (server re-validates on submit) ──
  function parseCookieInput(text) {
    const t = (text || '').trim();
    if (!t) return { cookies: [], format: '—' };
    if (t[0] === '[' || t[0] === '{') {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) {
          return {
            cookies: j
              .filter((x) => x?.name && x?.value)
              .map((x) => ({ name: String(x.name), value: String(x.value), domain: x.domain || null })),
            format: 'Cookie-Editor JSON',
          };
        }
        if (typeof j === 'object') {
          return {
            cookies: Object.entries(j)
              .filter(([, v]) => typeof v === 'string' && v)
              .map(([name, value]) => ({ name, value, domain: null })),
            format: 'JSON object',
          };
        }
      } catch {
        /* fall through to header parsing */
      }
    }
    if (t.includes('\t')) {
      const rows = t
        .split(/\r?\n/)
        .map((l) => l.split('\t'))
        .filter((c) => c.length >= 7 && !c[0].startsWith('#'));
      if (rows.length) {
        return {
          cookies: rows.map((c) => ({ name: c[5].trim(), value: c[6].trim(), domain: c[0].trim() })),
          format: 'cookies.txt (Netscape)',
        };
      }
    }
    const parts = t
      .split(/;|\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const cookies = parts
      .map((p) => {
        const i = p.indexOf('=');
        return i > 0 ? { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: null } : null;
      })
      .filter(Boolean);
    return { cookies, format: t.includes('\n') ? 'name=value lines' : 'Cookie header' };
  }

  function qwenFilter(cookies) {
    const withDomain = cookies.filter((c) => c.domain);
    if (!withDomain.length) return { kept: cookies, dropped: [] };
    const known = new Set([...REQUIRED_COOKIES, ...RECOMMENDED_COOKIES]);
    const kept = cookies.filter(
      (c) =>
        !c.domain || QWEN_DOMAIN_RE.test(c.domain) || SHARED_DOMAIN_RE.test(c.domain) || known.has(c.name),
    );
    const dropped = cookies.filter((c) => !kept.includes(c));
    if (!kept.some((c) => REQUIRED_COOKIES.includes(c.name))) return { kept: cookies, dropped: [] };
    return { kept, dropped };
  }

  function renderCookieState() {
    const { cookies, format } = parseCookieInput($('#cookie-input')?.value ?? '');
    const { kept, dropped } = qwenFilter(cookies);
    const names = kept.map((c) => c.name.toLowerCase());
    const fmt = $('#cookie-format');
    if (fmt) fmt.textContent = `format: ${format}`;
    const cnt = $('#cookie-count');
    if (cnt) {
      cnt.textContent = `${kept.length} cookies${dropped.length ? ` (+${dropped.length} other-domain skipped)` : ''}`;
    }
    const audit = $('#cookie-audit');
    if (audit) {
      audit.innerHTML = REQUIRED_COOKIES.map(
        (n) =>
          `<span class="req ${names.includes(n) ? 'ok' : 'miss'}" title="${n}">${names.includes(n) ? '✓' : '✗'} ${n}</span>`,
      ).join('');
    }
    const recHits = RECOMMENDED_COOKIES.filter((n) => names.includes(n));
    const chips = $('#cookie-chips');
    if (chips) {
      chips.innerHTML = kept
        .slice(0, 40)
        .map(
          (c) =>
            `<span class="chip${REQUIRED_COOKIES.includes(c.name.toLowerCase()) ? ' key' : recHits.includes(c.name.toLowerCase()) ? ' rec' : ''}" title="${esc(c.value.slice(0, 8))}…">${esc(c.name)}</span>`,
        )
        .join('');
    }
    const addBtn = $('#cookie-add');
    if (addBtn) addBtn.textContent = pendingCookieAccountId ? 'Update cookies' : 'Add account';
  }

  let cookieDebounce;
  $('#cookie-input')?.addEventListener('input', () => {
    clearTimeout(cookieDebounce);
    cookieDebounce = setTimeout(renderCookieState, 120);
  });
  $('#cookie-input')?.addEventListener('paste', () => setTimeout(renderCookieState, 0));

  const drop = $('#cookie-drop');
  const cookieFile = $('#cookie-file');
  const readCookieFile = (f) => {
    const reader = new FileReader();
    reader.onload = () => {
      const ta = $('#cookie-input');
      if (ta) ta.value = String(reader.result || '');
      switchTab('cookies');
      renderCookieState();
      toast(`Loaded ${f.name}`);
    };
    reader.readAsText(f);
  };
  drop?.addEventListener('click', () => cookieFile?.click());
  drop?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      cookieFile?.click();
    }
  });
  for (const ev of ['dragenter', 'dragover']) {
    drop?.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('hot');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop?.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('hot');
    });
  }
  drop?.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) readCookieFile(f);
  });
  cookieFile?.addEventListener('change', () => {
    const f = cookieFile.files?.[0];
    if (f) readCookieFile(f);
  });

  $('#cookie-check')?.addEventListener('click', async () => {
    const msg = $('#cookie-msg');
    const raw = $('#cookie-input')?.value ?? '';
    if (!raw.trim()) {
      toast('Paste or drop cookies first', true);
      return;
    }
    msg.textContent = 'probing chat.qwen.ai…';
    try {
      const res = await api('/accounts/verify', { method: 'POST', body: JSON.stringify({ cookies: raw }) });
      msg.innerHTML = res.ok
        ? `<span class="ok-text">✓ session accepted · ${res.cookieCount} cookies · ${esc(res.message)}</span>`
        : `<span class="err-text">✗ ${esc(res.message)}</span>`;
      if (res.warnings?.length)
        msg.innerHTML += ` <span class="muted">(${res.warnings.map(esc).join('; ')})</span>`;
    } catch (err) {
      msg.innerHTML = `<span class="err-text">${esc(err.message)}</span>`;
    }
  });

  $('#cookie-add')?.addEventListener('click', async () => {
    const raw = $('#cookie-input')?.value ?? '';
    const label = $('#cookie-label')?.value?.trim() || '';
    if (!raw.trim()) {
      toast('Paste or drop cookies first', true);
      return;
    }
    try {
      if (pendingCookieAccountId) {
        await api(`/accounts/${pendingCookieAccountId}`, {
          method: 'PATCH',
          body: JSON.stringify({ cookies: raw }),
        });
        toast('Cookies updated');
        pendingCookieAccountId = null;
      } else {
        const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(label);
        const body = isEmail ? { cookies: raw, email: label } : { cookies: raw, label: label || undefined };
        const res = await api('/accounts', { method: 'POST', body: JSON.stringify(body) });
        toast(
          `Account added: ${res.email}${res.warnings?.length ? ` (⚠ ${res.warnings.join('; ')})` : ''}`,
          !!res.warnings?.length,
        );
      }
      const ta = $('#cookie-input');
      if (ta) ta.value = '';
      const msg = $('#cookie-msg');
      if (msg) msg.textContent = '';
      renderCookieState();
      renderAccounts();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ── login link (capture portal) ──
  $('#link-create')?.addEventListener('click', async () => {
    try {
      const res = await api('/capture', { method: 'POST' });
      $('#link-idle').classList.add('hidden');
      $('#link-active').classList.remove('hidden');
      $('#link-url').value = res.url;
      $('#link-url').dataset.ticket = res.ticket;
      startLinkPoll(res.ticket, res.expiresInSeconds);
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#link-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#link-url').value);
      toast('Link copied');
    } catch {
      $('#link-url').select();
      document.execCommand('copy');
      toast('Link copied');
    }
  });
  $('#link-open')?.addEventListener('click', () => window.open($('#link-url').value, '_blank'));
  $('#link-cancel')?.addEventListener('click', async () => {
    const ticket = $('#link-url').dataset.ticket;
    if (ticket) await api(`/capture/${ticket}`, { method: 'DELETE' }).catch(() => {});
    stopLinkPoll();
    $('#link-active').classList.add('hidden');
    $('#link-idle').classList.remove('hidden');
  });
  function stopLinkPoll() {
    clearInterval(linkPoll);
    linkPoll = null;
  }
  function startLinkPoll(ticket, totalSeconds) {
    stopLinkPoll();
    const tick = async () => {
      try {
        const st = await api(`/capture/${ticket}`);
        const pill = $('#link-status');
        pill.className = `pill ${st.status}`;
        pill.textContent =
          st.status === 'captured'
            ? `✅ captured: ${st.email || 'account'}`
            : st.status === 'expired'
              ? '⌛ expired'
              : 'waiting for login…';
        $('#link-timer').textContent =
          `${Math.floor(st.expiresInSeconds / 60)}:${String(st.expiresInSeconds % 60).padStart(2, '0')} left`;
        $('#link-progress').style.width =
          `${Math.max(0, Math.min(100, 100 - (st.expiresInSeconds / totalSeconds) * 100))}%`;
        $('#link-cookies').textContent = st.cookieNames?.length
          ? `cookies: ${st.cookieNames.join(', ')}`
          : '';
        if (st.status === 'captured') {
          stopLinkPoll();
          toast(`Session captured → ${st.email}`);
          renderAccounts();
          setTimeout(() => {
            $('#link-active').classList.add('hidden');
            $('#link-idle').classList.remove('hidden');
          }, 4000);
        } else if (st.status === 'expired') {
          stopLinkPoll();
        }
      } catch {
        /* transient */
      }
    };
    tick();
    linkPoll = setInterval(tick, 2000);
  }

  // ── accounts table ──
  async function renderAccounts() {
    const data = await api('/accounts');
    accountsCache = data.data || [];
    renderAccountsTable();
  }
  function renderAccountsTable() {
    const q = ($('#acc-search')?.value ?? '').toLowerCase().trim();
    const rows = q
      ? accountsCache.filter((a) =>
          [a.email, a.status, a.authKind, a.source, a.id].join(' ').toLowerCase().includes(q),
        )
      : accountsCache;
    const summary = $('#acc-summary');
    if (summary) {
      const active = accountsCache.filter((a) => a.status === 'active').length;
      summary.textContent = `${active}/${accountsCache.length} active`;
    }
    const html = rows
      .map(
        (a) => `
      <tr>
        <td class="mono">${esc(a.email)}
          <div class="row tags">
            <span class="tag ${a.authKind === 'cookie' ? 'cookie' : 'password'}">${a.authKind === 'cookie' ? `🍪 ${a.cookieCount ?? 0} cookies` : '🔑 password'}</span>
            ${a.source && a.source !== 'manual' ? `<span class="tag src">${esc(a.source)}</span>` : ''}
          </div>
        </td>
        <td><span class="status ${esc(a.status)}">${esc(a.status)}</span>${
          a.cooldownRemainingMs
            ? `<div class="muted mono">${Math.ceil(a.cooldownRemainingMs / 1000)}s left</div>`
            : ''
        }</td>
        <td class="muted">${fmtAgo(a.lastUsed)}</td>
        <td class="mono">${a.requestsServed ?? 0} req / ${a.errorCount ?? 0} err</td>
        <td class="muted mono" title="${esc(a.lastError || '')}">${esc((a.lastError || '').slice(0, 42))}</td>
        <td>
          <div class="row">
            <button class="btn xs" data-act="toggle" data-id="${a.id}" data-enabled="${a.enabled ? '1' : '0'}">${a.enabled ? 'disable' : 'enable'}</button>
            <button class="btn xs" data-act="test" data-id="${a.id}">test</button>
            ${a.authKind === 'cookie' ? `<button class="btn xs" data-act="reimport" data-id="${a.id}" data-email="${esc(a.email)}">re-import</button>` : ''}
            <button class="btn xs" data-act="cooldown" data-id="${a.id}">clear cd</button>
            <button class="btn xs danger" data-act="del" data-id="${a.id}">delete</button>
          </div>
        </td>
      </tr>`,
      )
      .join('');
    $('#accounts-table').innerHTML = rows.length
      ? `<table><thead><tr><th>account</th><th>status</th><th>last used</th><th>usage</th><th>last error</th><th>actions</th></tr></thead><tbody>${html}</tbody></table>`
      : '<span class="muted">No accounts yet — add one above: password, cookies or a login link.</span>';
  }
  $('#acc-search')?.addEventListener('input', () => renderAccountsTable());
  $('#acc-refresh')?.addEventListener('click', () => renderAccounts().catch((e) => toast(e.message, true)));

  $('#add-account')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/accounts', {
        method: 'POST',
        body: JSON.stringify({ email: $('#acc-email').value, password: $('#acc-password').value }),
      });
      $('#acc-password').value = '';
      toast('Account added');
      renderAccounts();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    try {
      if (act === 'toggle') {
        await api(`/accounts/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: btn.dataset.enabled !== '1' }),
        });
      } else if (act === 'del') {
        if (!confirm('Delete this account?')) return;
        await api(`/accounts/${id}`, { method: 'DELETE' });
      } else if (act === 'test') {
        const res = await api(`/accounts/${id}/test`, { method: 'POST' });
        toast(res.ok ? `Session OK: ${res.message}` : `Failed: ${res.message}`, !res.ok);
      } else if (act === 'cooldown') {
        await api(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ clearCooldown: true }) });
      } else if (act === 'reimport') {
        pendingCookieAccountId = id;
        switchTab('cookies');
        $('#cookie-label').value = btn.dataset.email || '';
        $('#cookie-msg').textContent =
          `Re-importing cookies for ${btn.dataset.email} — drop/paste a fresh export and press “Update cookies”.`;
        $('#cookie-input')?.focus();
        renderCookieState();
        return;
      }
      if (page === 'accounts') renderAccounts();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ── logs ─────────────────────────────────────────────────────────────────
  let logsCache = [];
  async function renderLogs() {
    const q = new URLSearchParams();
    if ($('#f-q').value) q.set('q', $('#f-q').value);
    if ($('#f-status').value) q.set('status', $('#f-status').value);
    if ($('#f-model').value) q.set('model', $('#f-model').value);
    const data = await api(`/logs?${q.toString()}`);
    logsCache = data.entries || [];
    renderLogsTable();
    const models = [...new Set(logsCache.map((l) => l.model))];
    const sel = $('#f-model');
    const current = sel.value;
    sel.innerHTML = `<option value="">all models</option>${models.map((m) => `<option ${m === current ? 'selected' : ''}>${esc(m)}</option>`).join('')}`;
  }
  function renderLogsTable() {
    const rows = logsCache
      .map(
        (l, i) => `
      <tr>
        <td class="mono muted">${fmtTime(l.timestamp)}</td>
        <td class="mono">${esc(l.model)}</td>
        <td class="mono muted">${esc(l.accountEmail || '—')}</td>
        <td class="mono">${l.durationMs}ms</td>
        <td><span class="status ${l.status < 400 ? 'ok' : 'error'}">${l.status}</span></td>
        <td class="mono">${l.stream ? 'sse' : 'json'}</td>
        <td class="mono">${l.totalTokens ?? '—'}</td>
        <td><details class="expand"><summary>details</summary><pre>${esc(JSON.stringify(l, null, 2))}</pre></details></td>
      </tr>`,
      )
      .join('');
    $('#logs-table').innerHTML = rows
      ? `<table><thead><tr><th>time</th><th>model</th><th>account</th><th>duration</th><th>status</th><th>mode</th><th>tokens</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<span class="muted">No requests logged yet.</span>';
  }
  $('#f-refresh')?.addEventListener('click', renderLogs);
  $('#f-q')?.addEventListener('keydown', (e) => e.key === 'Enter' && renderLogs());
  $('#f-status')?.addEventListener('change', renderLogs);
  $('#f-model')?.addEventListener('change', renderLogs);

  // ── network ──────────────────────────────────────────────────────────────
  async function renderNetwork() {
    const data = await api('/network');
    const rows = (data.entries || [])
      .map(
        (n) => `
      <tr>
        <td class="mono muted">${fmtTime(n.ts)}</td>
        <td class="mono">${esc(n.method)}</td>
        <td class="mono" style="word-break:break-all">${esc(n.url)}</td>
        <td><span class="status ${n.status && n.status < 400 ? 'ok' : 'error'}">${n.status ?? '—'}</span></td>
        <td class="mono">${n.durationMs ?? '—'}ms</td>
        <td><details class="expand"><summary>inspect</summary><pre>${esc(JSON.stringify(n, null, 2))}</pre></details></td>
      </tr>`,
      )
      .join('');
    $('#network-table').innerHTML = rows
      ? `<table><thead><tr><th>time</th><th>method</th><th>url</th><th>status</th><th>duration</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : '<span class="muted">No outbound calls captured. Enable NETWORK_DEBUG in Settings.</span>';
  }
  $('#net-refresh')?.addEventListener('click', renderNetwork);
  $('#net-clear')?.addEventListener('click', async () => {
    await api('/network/clear', { method: 'POST' });
    renderNetwork();
  });

  // ── settings: config.json editor (Monaco, with offline fallback) ─────────
  const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';
  let monacoEditor = null;
  let monacoLib = null;

  /** Single accessor so save / reload / format work with either editor. */
  const cfgEditor = {
    get value() {
      return monacoEditor ? monacoEditor.getValue() : ($('#cfg-editor')?.value ?? '');
    },
    set value(text) {
      if (monacoEditor) monacoEditor.setValue(text);
      else if ($('#cfg-editor')) $('#cfg-editor').value = text;
    },
    get isMonaco() {
      return !!monacoEditor;
    },
  };

  function loadScriptOnce(src, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      const timer = setTimeout(() => reject(new Error(`timeout loading ${src}`)), timeoutMs);
      el.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      el.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`failed to load ${src}`));
      };
      document.head.appendChild(el);
    });
  }

  function setEditorBadge(text) {
    const el = $('#cfg-editor-mode');
    if (el) el.textContent = text;
  }

  /** Plain-textarea upgrades: Tab indents, Ctrl/Cmd+S saves, live JSON check. */
  function enhancePlainEditor(ta) {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart;
        ta.value = `${ta.value.slice(0, start)}  ${ta.value.slice(ta.selectionEnd)}`;
        ta.selectionStart = start + 2;
        ta.selectionEnd = start + 2;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        $('#cfg-save')?.click();
      }
    });
    let debounce;
    ta.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          JSON.parse(ta.value);
          $('#cfg-problems').textContent = '';
        } catch (err) {
          $('#cfg-problems').textContent = err.message;
        }
      }, 400);
    });
  }

  async function initConfigEditor() {
    const host = $('#cfg-monaco');
    const ta = $('#cfg-editor');
    if (!host || !ta) return;
    try {
      await loadScriptOnce(`${MONACO_CDN}/loader.js`);
      await new Promise((resolve, reject) => {
        const loader = globalThis.require;
        if (!loader) return reject(new Error('Monaco loader did not register require()'));
        loader.config({ paths: { vs: MONACO_CDN } });
        loader(['vs/editor/editor.main'], resolve, reject);
      });
      monacoLib = globalThis.monaco;
      monacoEditor = monacoLib.editor.create(host, {
        value: ta.value || '{}',
        language: 'json',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: false,
        formatOnPaste: true,
      });
      host.classList.remove('hidden');
      ta.classList.add('hidden');
      setEditorBadge('editor: monaco');
      monacoLib.editor.onDidChangeMarkers(() => {
        const model = monacoEditor.getModel();
        if (!model) return;
        const markers = monacoLib.editor.getModelMarkers({ resource: model.uri });
        $('#cfg-problems').textContent = markers
          .map((m) => `${m.startLineNumber}:${m.startColumn} ${m.message}`)
          .join(' · ');
      });
      monacoEditor.addCommand(monacoLib.KeyMod.CtrlCmd | monacoLib.KeyCode.KeyS, () => {
        $('#cfg-save')?.click();
      });
    } catch (err) {
      // air-gapped host / blocked CDN → keep the built-in editor
      setEditorBadge('editor: plain (Monaco offline)');
      enhancePlainEditor(ta);
    }
  }

  async function loadConfig() {
    const raw = await api('/config/raw');
    cfgEditor.value = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    $('#cfg-problems').textContent = '';
  }

  $('#cfg-reload')?.addEventListener('click', () => loadConfig().catch((e) => toast(e.message, true)));
  $('#cfg-format')?.addEventListener('click', () => {
    try {
      if (cfgEditor.isMonaco) monacoEditor.getAction('editor.action.formatDocument')?.run();
      else cfgEditor.value = JSON.stringify(JSON.parse(cfgEditor.value), null, 2);
      $('#cfg-problems').textContent = '';
    } catch (err) {
      $('#cfg-problems').textContent = err.message;
      toast(err.message, true);
    }
  });
  $('#cfg-save')?.addEventListener('click', async () => {
    const raw = cfgEditor.value;
    try {
      JSON.parse(raw); // client-side pre-check
      await api('/config', { method: 'PUT', body: JSON.stringify({ raw }) });
      $('#cfg-problems').textContent = '';
      toast('Config saved & hot-reloaded');
      loadConfig();
    } catch (err) {
      $('#cfg-problems').textContent = err.message;
      toast(err.message, true);
    }
  });

  // ── boot ─────────────────────────────────────────────────────────────────
  const boot = {
    overview: () => {
      renderOverview().catch((e) => toast(e.message, true));
      connectStream({
        system: () => {
          // append live
          renderOverviewDebounced();
        },
        request: () => renderOverviewDebounced(),
      });
      let h;
      function renderOverviewDebounced() {
        clearTimeout(h);
        h = setTimeout(() => renderOverview().catch(() => {}), 800);
      }
    },
    accounts: () => renderAccounts().catch((e) => toast(e.message, true)),
    logs: () => {
      renderLogs().catch((e) => toast(e.message, true));
      connectStream({
        request: (entry) => {
          if (!$('#f-live').checked) return;
          logsCache = [entry, ...logsCache].slice(0, 200);
          renderLogsTable();
        },
      });
    },
    network: () => {
      renderNetwork().catch((e) => toast(e.message, true));
      setInterval(() => renderNetwork().catch(() => {}), 10000);
    },
    settings: async () => {
      await initConfigEditor();
      await loadConfig().catch((e) => toast(e.message, true));
    },
  };

  api('/overview')
    .then((d) => {
      $('#provider-badge').textContent = `provider: ${d.provider}`;
    })
    .catch(() => {});
  boot[page]?.();
})();
