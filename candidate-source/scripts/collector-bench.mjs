import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { planSearch } from '../src/search/planner.ts';
import { collectSearch } from '../src/search/collector.ts';

const [countArg, persistence = 'off', runTag = 'sample'] = process.argv.slice(2);
const target = Number(countArg);
if (![5000, 20000].includes(target) || !['on', 'off'].includes(persistence)) {
  throw new Error('usage: node --import tsx scripts/collector-bench.mjs 5000|20000 on|off [tag]');
}

const count = target;
const start = Date.UTC(2025, 0, 1);
const end = Date.UTC(2026, 0, 1);
const duration = end - start;
const rows = Array.from({ length: count }, (_, i) => {
  const n = count - 1 - i;
  const ts = start + Math.floor((n + 0.5) * duration / count);
  return {
    id: String(700000000 + n), name: `Senior Software Engineer ${n} — Platform and Data Systems`,
    employer: { id: String(100000 + n % 300), name: `Example Employer ${n % 300}`, url: `https://example.test/employer/${n % 300}` },
    area: { id: '1', name: 'Moscow', url: 'https://api.hh.ru/areas/1' },
    salary: { from: 180000 + n % 80000, to: 280000 + n % 120000, currency: 'RUR', gross: Boolean(n % 2) },
    experience: { id: 'between1And3', name: '1–3 years' }, employment: { id: 'full', name: 'Full time' },
    schedule: { id: 'remote', name: 'Remote' }, work_format: [{ id: 'REMOTE', name: 'Remote' }],
    published_at: new Date(ts).toISOString(), created_at: new Date(ts - 3600000).toISOString(),
    alternate_url: `https://hh.ru/vacancy/${700000000 + n}`, url: `https://api.hh.ru/vacancies/${700000000 + n}`,
    snippet: { requirement: 'Build reliable services, review code, design APIs, monitor production systems, and collaborate across product and engineering teams. '.repeat(2), responsibility: 'Own service quality, improve performance, document decisions, and support a healthy on-call rotation. '.repeat(2) },
    professional_roles: [{ id: '96', name: 'Programmer, developer' }], response_url: null, has_test: false,
    branded_description: null, work_schedule_by_days: ['FIVE_ON_TWO_OFF'],
  };
});
const timestamps = rows.map((item) => Date.parse(item.published_at));
const plan = planSearch({ mode: 'comprehensive', native: { date_from: '2025-01-01', date_to: '2025-12-31' }, limits: { max_requests: 1000, max_items: 50000, max_duration_sec: 1800, max_bytes: 128 * 1024 * 1024, max_detail_fetches: 0 } }, Date.UTC(2026, 0, 2));
let responses = 0;
let checkpointBytes = 0;
let checkpointWrites = 0;
const get = async (path, { budget } = {}) => {
  const url = new URL(path, 'https://api.hh.ru');
  const from = Date.parse(url.searchParams.get('date_from'));
  const to = Date.parse(url.searchParams.get('date_to'));
  const pageNo = Number(url.searchParams.get('page') ?? 0);
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (timestamps[mid] > to) lo = mid + 1; else hi = mid; }
  const firstIndex = lo;
  lo = firstIndex;
  hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (timestamps[mid] >= from) lo = mid + 1; else hi = mid; }
  const selected = rows.slice(firstIndex, lo);
  const body = { found: selected.length, pages: Math.min(20, Math.ceil(selected.length / 100)), items: selected.slice(pageNo * 100, pageNo * 100 + 100) };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (budget) { budget.requests++; budget.bytes += bytes; }
  responses++;
  return body;
};

const outputDir = '/tmp/hh-collector-bench';
fs.mkdirSync(outputDir, { recursive: true });
const persistPath = `${outputDir}/checkpoint-${target}-${persistence}-${runTag}.json`;
const onCheckpoint = persistence === 'on' ? async (state) => {
  const json = JSON.stringify(state);
  checkpointBytes = Buffer.byteLength(json);
  fs.writeFileSync(persistPath, json);
  checkpointWrites++;
} : undefined;
const before = performance.now();
const result = await collectSearch(plan, { get, ...(onCheckpoint ? { onCheckpoint } : {}) });
const elapsedMs = performance.now() - before;
const checkpoint = JSON.stringify(result.checkpoint);
checkpointBytes = Buffer.byteLength(checkpoint);
fs.writeFileSync(`${outputDir}/result-${target}-${persistence}-${runTag}.json`, JSON.stringify({ status: result.status, found: result.manifest.found, known_items: result.manifest.known_items, requests: result.manifest.requests, logical_pages: result.manifest.logical_pages, partitions: result.manifest.partitions.length, gaps: result.manifest.gaps.map((gap) => gap.code), checkpoint_bytes: checkpointBytes }));
if (persistence === 'on') fs.writeFileSync(persistPath, checkpoint);
console.log(JSON.stringify({ target, persistence, elapsed_ms: Math.round(elapsedMs), process_max_rss_kib: process.resourceUsage().maxRSS, status: result.status, found: result.manifest.found, known_items: result.manifest.known_items, requests: result.manifest.requests, logical_pages: result.manifest.logical_pages, partitions: result.checkpoint.partitions.length, responses, checkpoint_bytes: checkpointBytes, checkpoint_limit_bytes: 32 * 1024 * 1024, checkpoint_writes: checkpointWrites, gaps: result.manifest.gaps.map((gap) => gap.code) }));
