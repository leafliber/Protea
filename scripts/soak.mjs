#!/usr/bin/env node
// Long-running stability test (docs/40-plan/01-roadmap.md M6): feeds a running Protea simulated
// events through the control API, samples /metrics, and reports memory growth, database growth
// and event latency. Plain Node.js, no dependencies; run it against a container or a local daemon
// whose provider is `echo` (providers.default: echo) so no model is paid for.
//
//   node scripts/soak.mjs --url http://127.0.0.1:7788 --token-file /path/PROTEA_ADMIN_TOKEN \
//        --hours 72 --rate 2 --out soak.jsonl
//
// Exit code 1 when memory grows by more than --max-growth (default 5) % per day after warm-up.
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.PROTEA_URL ?? 'http://127.0.0.1:7788' },
    token: { type: 'string', default: process.env.PROTEA_ADMIN_TOKEN },
    'token-file': { type: 'string' },
    hours: { type: 'string', default: '72' },
    rate: { type: 'string', default: '2' }, // events per minute
    sample: { type: 'string', default: '60' }, // seconds between samples
    warmup: { type: 'string', default: '0.1' }, // fraction of the run left out of the growth fit
    'max-growth': { type: 'string', default: '5' }, // % per day
    out: { type: 'string', default: 'soak.jsonl' },
  },
});
const token = a.token ?? (a['token-file'] ? fs.readFileSync(a['token-file'], 'utf8').trim() : undefined);
if (!token) throw new Error('pass --token or --token-file (the admin token)');
const base = a.url.replace(/\/$/, '');
const durationMs = Number(a.hours) * 3_600_000;
const perMinute = Number(a.rate);
const sampleMs = Number(a.sample) * 1000;
const headers = { authorization: `Bearer ${token}` };

// Levels as an owner's day might mix them: mostly background, some direct messages.
const MIX = [
  { level: 1, weight: 0.15, text: (n) => `owner message ${n}: what is on my list today?` },
  { level: 2, weight: 0.25, text: (n) => `CI run ${n} finished with 2 failures in packages/core` },
  { level: 3, weight: 0.35, text: (n) => `feed item ${n}: a long article summary ${'lorem ipsum '.repeat(20)}` },
  { level: 4, weight: 0.25, text: (n) => `background note ${n}` },
];
function pick() {
  let r = Math.random();
  for (const m of MIX) {
    if ((r -= m.weight) <= 0) return m;
  }
  return MIX[MIX.length - 1];
}

/** Prometheus text → { name{labels}: value }. */
function parseMetrics(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return out;
}
const sum = (m, prefix) => [...m].filter(([k]) => k === prefix || k.startsWith(`${prefix}{`)).reduce((s, [, v]) => s + v, 0);

/** P95 from the difference of two cumulative histograms (bucket upper bounds in seconds). */
function quantile(now, start, name, level, q) {
  const buckets = [];
  for (const [k, v] of now) {
    const m = new RegExp(`^${name}_bucket\\{(?=.*level="${level}")(?=.*le="([^"]+)").*\\}$`).exec(k);
    if (!m) continue;
    buckets.push({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), n: v - (start.get(k) ?? 0) });
  }
  buckets.sort((x, y) => x.le - y.le);
  const total = buckets.at(-1)?.n ?? 0;
  if (total === 0) return null;
  const want = q * total;
  for (const b of buckets) if (b.n >= want) return b.le;
  return Infinity;
}

async function metrics() {
  const res = await fetch(`${base}/metrics`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`/metrics answered ${res.status}`);
  return parseMetrics(await res.text());
}

let sent = 0;
let failed = 0;
async function push() {
  const m = pick();
  sent++;
  try {
    const res = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: m.text(sent), level: m.level, tags: ['soak'] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) failed++;
  } catch {
    failed++;
  }
}

/** Least-squares slope of y over x. */
function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

const t0 = Date.now();
const start = await metrics();
const samples = [];
const outFile = fs.createWriteStream(a.out, { flags: 'a' });
console.log(`soak: ${a.hours} h at ${perMinute} event(s)/min against ${base}; samples every ${a.sample}s → ${a.out}`);

const pushTimer = setInterval(() => void push(), 60_000 / perMinute);
async function sample() {
  try {
    const m = await metrics();
    const s = {
      at: new Date().toISOString(),
      elapsedH: (Date.now() - t0) / 3_600_000,
      rssMb: sum(m, 'process_resident_memory_bytes') / 1048576,
      heapMb: sum(m, 'nodejs_heap_size_used_bytes') / 1048576,
      dbMb: (m.get('protea_db_size_bytes{file="db"}') ?? 0) / 1048576,
      walMb: (m.get('protea_db_size_bytes{file="wal"}') ?? 0) / 1048576,
      pending: sum(m, 'protea_events_pending'),
      settled: sum(m, 'protea_events_total') - sum(start, 'protea_events_total'),
      p95L1: quantile(m, start, 'protea_event_to_request_seconds', 1, 0.95),
      p95L2: quantile(m, start, 'protea_event_to_request_seconds', 2, 0.95),
      lagP99Ms: (m.get('nodejs_eventloop_lag_p99_seconds') ?? 0) * 1000,
      sent,
      failed,
    };
    samples.push(s);
    outFile.write(`${JSON.stringify(s)}\n`);
    console.log(
      `${s.elapsedH.toFixed(2)}h rss ${s.rssMb.toFixed(1)}MB heap ${s.heapMb.toFixed(1)}MB db ${s.dbMb.toFixed(2)}MB wal ${s.walMb.toFixed(2)}MB pending ${s.pending} settled ${s.settled} p95(L1) ${s.p95L1 ?? '–'}s sent ${sent} failed ${failed}`,
    );
  } catch (err) {
    console.error(`sample failed: ${err.message}`);
  }
}
const sampleTimer = setInterval(() => void sample(), sampleMs);
await sample();

await new Promise((resolve) => {
  const end = setTimeout(resolve, durationMs);
  const stop = () => {
    clearTimeout(end);
    resolve();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
});
clearInterval(pushTimer);
clearInterval(sampleTimer);
await sample();
outFile.end();

const hours = (Date.now() - t0) / 3_600_000;
const fit = samples.filter((s) => s.elapsedH >= hours * Number(a.warmup));
const heapSlope = slope(fit.map((s) => ({ x: s.elapsedH, y: s.heapMb })));
const rssSlope = slope(fit.map((s) => ({ x: s.elapsedH, y: s.rssMb })));
const meanRss = fit.reduce((x, s) => x + s.rssMb, 0) / Math.max(1, fit.length);
const meanHeap = fit.reduce((x, s) => x + s.heapMb, 0) / Math.max(1, fit.length);
const dbSlope = slope(fit.map((s) => ({ x: s.elapsedH, y: s.dbMb + s.walMb })));
const last = samples.at(-1) ?? {};
const report = {
  hours: Number(hours.toFixed(2)),
  eventsSent: sent,
  sendFailures: failed,
  settled: last.settled,
  pendingAtEnd: last.pending,
  rssGrowthPctPerDay: Number(((rssSlope * 24) / meanRss * 100).toFixed(2)),
  heapGrowthPctPerDay: Number(((heapSlope * 24) / meanHeap * 100).toFixed(2)),
  rssMb: { first: samples[0]?.rssMb, last: last.rssMb, mean: Number(meanRss.toFixed(1)) },
  dbGrowthMbPerDay: Number((dbSlope * 24).toFixed(2)),
  dbMbAtEnd: Number((last.dbMb ?? 0).toFixed(2)),
  p95SecondsL1: last.p95L1,
  p95SecondsL2: last.p95L2,
};
console.log(JSON.stringify(report, null, 2));
const over = report.rssGrowthPctPerDay > Number(a['max-growth']) && report.heapGrowthPctPerDay > Number(a['max-growth']);
if (over) console.error(`memory grew by more than ${a['max-growth']} %/day`);
process.exit(over || failed > sent * 0.01 ? 1 : 0);
