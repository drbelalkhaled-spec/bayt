// Health check for the live Bayt site (used by .github/workflows/health.yml).
// Run: node tools/health-check.mjs https://bayt.dr-belal-khaled.workers.dev
// Env: HC_ATTEMPTS = tries before giving up (default 5, 20 s apart: a fresh deploy takes a moment to spread).
// Exit code 0 = every check passed on some attempt, 1 = it never did.
import { appendFileSync } from 'node:fs';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node tools/health-check.mjs <base-url>');
  process.exit(2);
}
const attempts = Math.max(1, Number(process.env.HC_ATTEMPTS) || 5);

const get = (path) =>
  fetch(base + path, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const type = (res) => res.headers.get('content-type') ?? '';

let bundle = ''; // path of the app's JS file, found on the home page and fetched by the next check

const checks = [
  ['health', async () => {
    const res = await get('/api/health');
    expect(res.status === 200, `status ${res.status}`);
    const body = await res.json();
    expect(JSON.stringify(body) === '{"ok":true}', `unexpected body ${JSON.stringify(body)}`);
  }],
  ['index page', async () => {
    const res = await get(`/?hc=${Date.now()}`);
    expect(res.status === 200, `status ${res.status}`);
    expect(type(res).includes('text/html'), `content-type ${type(res)}`);
    bundle = (await res.text()).match(/<script[^>]*\ssrc="(\/assets\/index-[^"]+\.js)"/)?.[1] ?? '';
    expect(bundle, 'no /assets/index-<hash>.js script tag found');
  }],
  ['app bundle', async () => {
    expect(bundle, 'skipped: no bundle path from the index page');
    const res = await get(bundle);
    expect(res.status === 200, `${bundle} status ${res.status}`);
    expect(type(res).includes('javascript'), `content-type ${type(res)}`);
    const size = (await res.arrayBuffer()).byteLength;
    expect(size > 10_000, `${bundle} only ${size} bytes`);
  }],
  ['service worker', async () => {
    const res = await get('/sw.js');
    expect(res.status === 200, `status ${res.status}`);
    expect(type(res).includes('javascript'), `content-type ${type(res)}`);
  }],
  ['manifest', async () => {
    const res = await get('/manifest.webmanifest');
    expect(res.status === 200, `status ${res.status}`);
    const name = (await res.json()).name;
    expect(name === 'Bayt', `name is ${JSON.stringify(name)}`);
  }],
  ['auth enforced', async () => {
    const res = await get('/api/me');
    expect(res.status === 401, `expected 401, got ${res.status}`);
  }],
];

let results = [];
for (let attempt = 1; attempt <= attempts; attempt++) {
  if (attempt > 1) await new Promise((r) => setTimeout(r, 20_000));
  console.log(`Attempt ${attempt}/${attempts} against ${base}`);
  results = [];
  bundle = '';
  for (const [name, run] of checks) {
    try {
      await run();
      results.push({ name, ok: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timed out after 15 s' : (err?.message ?? String(err));
      results.push({ name, ok: false, reason });
      console.log(`✗ ${name}: ${reason}`);
    }
  }
  if (results.every((r) => r.ok)) break;
}

const passed = results.filter((r) => r.ok).length;
const ok = passed === results.length;
console.log(ok ? `All ${passed} checks passed.` : `FAILED: ${passed}/${results.length} checks passed.`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.name} | ${r.ok ? '✅ pass' : '❌ fail'} | ${r.reason ?? ''} |`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Live health check: ${ok ? 'passed' : 'FAILED'}\n\n${base}\n\n| Check | Result | Detail |\n| --- | --- | --- |\n${rows.join('\n')}\n`,
  );
}
process.exitCode = ok ? 0 : 1; // not process.exit(): it can crash Node on Windows while sockets are still closing
