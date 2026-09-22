/**
 * End-to-end smoke test against a RUNNING gateway instance.
 * Usage: BASE_URL=http://localhost:26405 MASTER_KEY=xxx bun scripts/smoke.ts
 * (MASTER_KEY is optional when the dashboard cookie/key is not required.)
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:26410';
const MASTER = process.env.MASTER_KEY ?? '';
const H = { 'Content-Type': 'application/json', 'X-Master-Key': MASTER };
const THINK_OPEN = '<' + 'think>';
const FN_ARTIFACT = '<' + 'function=';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// 1. health
const health = await fetch(`${BASE}/health`).then((r) => r.json());
check('GET /health', health.status === 'ok', `provider=${health.provider}`);

// This suite asserts *mock provider* behaviour (fake accounts, simulated rate
// limits, artifact-tag filtering). With PROVIDER=auto the gateway starts in
// mock mode but flips to the real provider as soon as the accounts below are
// added, which makes every later check fail with confusing "login failed"
// errors — so refuse to run instead.
const cfg = MASTER
  ? await fetch(`${BASE}/dashboard/api/config`, { headers: H })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
  : null;
if (health.provider !== 'mock' || cfg?.PROVIDER === 'auto') {
  console.error(
    '\nFATAL: the gateway is not pinned to the mock provider ' +
      `(health.provider="${health.provider}", PROVIDER="${cfg?.PROVIDER ?? 'unknown'}").\n` +
      'The smoke suite exercises mock behaviour only. Restart the gateway with:\n' +
      '  PROVIDER=mock bun run src/cli.ts start      # or: bun run src/cli.ts start --mock\n' +
      'then re-run:\n' +
      `  BASE_URL=${BASE} MASTER_KEY=<key> bun scripts/smoke.ts\n`,
  );
  process.exit(1);
}

// 2. models
const models = await fetch(`${BASE}/v1/models`).then((r) => r.json());
check(
  'GET /v1/models',
  Array.isArray(models.data) && models.data.length >= 4,
  `${models.data?.length} models`,
);

// 3. accounts CRUD + auth
for (const [email, pw] of [
  ['alice@mock.dev', 'pw1'],
  ['bob@mock.dev', 'pw2'],
] as const) {
  const r = await fetch(`${BASE}/accounts`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email, password: pw }),
  });
  const j = await r.json();
  check(`POST /accounts ${email}`, r.status === 201 || r.status === 409, j.id ?? '');
}
const accList = await fetch(`${BASE}/accounts`, { headers: H }).then((r) => r.json());
check('GET /accounts (master auth)', accList.data?.length >= 2, `${accList.data?.length} accounts`);
if (MASTER) {
  const noAuth = await fetch(`${BASE}/accounts`);
  check('GET /accounts without key -> 401', noAuth.status === 401);
}

// 4. non-streaming chat
const chat = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen3-max',
    messages: [{ role: 'user', content: 'Hello there, general kenobi' }],
  }),
}).then((r) => r.json());
const content = chat?.choices?.[0]?.message?.content ?? '';
check(
  'POST /v1/chat/completions',
  chat.object === 'chat.completion' && content.length > 20,
  `${content.length}B`,
);
check('content filter: no artifact tags', !content.includes(FN_ARTIFACT) && !content.includes(THINK_OPEN));
check('usage present', !!chat.usage?.total_tokens);

// 5. streaming chat (SSE)
const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen3-max',
    stream: true,
    messages: [{ role: 'user', content: 'Stream me a story' }],
  }),
});
check('stream headers', (res.headers.get('content-type') ?? '').includes('text/event-stream'));
const text = await res.text();
const chunks = text.split('\n\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
check('SSE chunks received', chunks.length > 3, `${chunks.length} chunks`);
check('SSE [DONE] terminator', text.trimEnd().endsWith('data: [DONE]'));
const first = JSON.parse(chunks[0]!.slice(6));
check('chunk shape', first.object === 'chat.completion.chunk' && !!first.choices?.[0]?.delta);
const streamed = chunks.map((c) => JSON.parse(c.slice(6)).choices?.[0]?.delta?.content ?? '').join('');
check(
  'streamed content filtered',
  streamed.length > 20 && !streamed.includes(THINK_OPEN) && !streamed.includes(FN_ARTIFACT),
  `${streamed.length}B`,
);

// 6. tool calling
const toolRes = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'qwen3-max',
    messages: [{ role: 'user', content: 'What is the weather? Please call the tool.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ],
  }),
}).then((r) => r.json());
const tc = toolRes?.choices?.[0]?.message?.tool_calls;
check(
  'tool call parsed',
  Array.isArray(tc) && tc[0]?.function?.name === 'get_weather',
  tc ? tc[0].function.arguments : 'none',
);
check('tool call id format', typeof tc?.[0]?.id === 'string' && tc[0].id.startsWith('call_'));
check('tool content stripped', !(toolRes?.choices?.[0]?.message?.content ?? '').includes('function_calls'));

// 7. rate-limit → cooldown visibility
const rl = await fetch(`${BASE}/accounts`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ email: 'rl@ratelimit.dev', password: 'x' }),
});
const rlAcc = await rl.json();
if (rl.status === 201 && MASTER) {
  const healthy = accList.data ?? [];
  for (const a of healthy)
    await fetch(`${BASE}/accounts/${a.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ enabled: false }),
    });
  const r2 = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-max', messages: [{ role: 'user', content: 'hi' }] }),
  });
  check(
    'rate-limited upstream surfaces 429/502',
    r2.status === 429 || r2.status === 502,
    `status=${r2.status}`,
  );
  await new Promise((r) => setTimeout(r, 300));
  const accAfter = await fetch(`${BASE}/accounts`, { headers: H }).then((r) => r.json());
  const rlAfter = accAfter.data.find((a: { id: string }) => a.id === rlAcc.id);
  check(
    'account entered cooldown',
    rlAfter?.status === 'cooldown' || rlAfter?.errorCount > 0,
    `status=${rlAfter?.status}`,
  );
  for (const a of healthy)
    await fetch(`${BASE}/accounts/${a.id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ enabled: true }),
    });
  await fetch(`${BASE}/accounts/${rlAcc.id}`, { method: 'DELETE', headers: H });
}

// 8. setup endpoints
const setup = await fetch(`${BASE}/setup/claude-code`).then((r) => r.json());
check(
  'GET /setup/claude-code',
  !!setup.powershell_command && !!setup.curl_example && !!setup.config?.endpoint,
);
const ps1 = await fetch(`${BASE}/install/claude.ps1`).then((r) => r.text());
check('GET /install/claude.ps1', ps1.includes('ANTHROPIC_BASE_URL'));
const sh = await fetch(`${BASE}/install/claude.sh`).then((r) => r.text());
check('GET /install/claude.sh', sh.includes('ANTHROPIC_BASE_URL'));

// 9. dashboard pages + api
for (const p of [
  '/dashboard',
  '/dashboard/accounts',
  '/dashboard/logs',
  '/dashboard/network',
  '/dashboard/settings',
]) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  check(`GET ${p}`, r.status === 200 && t.includes('<html'), `${r.status}`);
}
check('dashboard css', (await fetch(`${BASE}/dashboard/public/style.css`)).status === 200);
check('dashboard js', (await fetch(`${BASE}/dashboard/public/app.js`)).status === 200);
if (MASTER) {
  const ov = await fetch(`${BASE}/dashboard/api/overview`, { headers: H }).then((r) => r.json());
  check('dashboard api overview', !!ov.metrics && !!ov.modelHealth, `reqs=${ov.metrics?.totalRequests}`);
  const logs = await fetch(`${BASE}/dashboard/api/logs`, { headers: H }).then((r) => r.json());
  check(
    'dashboard api logs',
    Array.isArray(logs.entries) && logs.entries.length > 0,
    `${logs.entries?.length} entries`,
  );

  // 10. config hot reload
  const cfgRaw = await fetch(`${BASE}/dashboard/api/config/raw`, { headers: H }).then((r) => r.text());
  const cfgObj = JSON.parse(cfgRaw);
  const put = await fetch(`${BASE}/dashboard/api/config`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ raw: JSON.stringify(cfgObj, null, 2) }),
  });
  check('PUT config (validate+save)', put.status === 200);
  const badPut = await fetch(`${BASE}/dashboard/api/config`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ raw: '{"PORT": ' }),
  });
  check('PUT invalid config -> 422', badPut.status === 422);
}

// 11. validation errors
const bad = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'x' }),
});
check('invalid request -> 400', bad.status === 400);

console.log(`\nSMOKE RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
