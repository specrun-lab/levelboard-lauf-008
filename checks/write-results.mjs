// Schreibt den Gesamtstand nach frontend/dist/results.json (spec/05-datenmodell.md, „Ergebnis schreiben“).
// Aufruf: node write-results.mjs <level> [<level> …]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { levelTokens } from './collect-tokens.mjs';
import { imageSizeMB, pipelineOf } from './collect-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKS = path.join(ROOT, 'checks');
const RESULTS = path.join(ROOT, 'frontend', 'dist', 'results.json');

const args = process.argv.slice(2).map(Number);
if (args.length === 0 || args.some((n) => !Number.isInteger(n) || n < 1 || n > 10)) {
  console.error('Aufruf: node write-results.mjs <level> [<level> …]');
  process.exit(2);
}
const levels = [...new Set(args)].sort((a, b) => a - b);

// Alle Suites mit diesem Titel, rekursiv, und ihre Tests (ohne Doppelte).
function suitesTitled(suites, title, found = []) {
  for (const s of suites ?? []) {
    if (s.title === title) found.push(s);
    suitesTitled(s.suites, title, found);
  }
  return found;
}
function specsIn(suite, acc = []) {
  acc.push(...(suite.specs ?? []));
  for (const sub of suite.suites ?? []) specsIn(sub, acc);
  return acc;
}

const report = JSON.parse(readFileSync(path.join(CHECKS, '.out', 'playwright.json'), 'utf8'));
const groups = new Map();
for (const n of levels) {
  const seen = new Map();
  for (const suite of suitesTitled(report.suites, `level-${n}`)) {
    for (const spec of specsIn(suite)) seen.set(spec.id ?? `${spec.file}:${spec.line}:${spec.title}`, spec);
  }
  const specs = [...seen.values()];
  if (specs.length === 0) throw new Error(`keine Checks für Level ${n} im Report gefunden`);
  const checks = specs.map((spec) => ({
    name: spec.title,
    ok: Boolean(spec.ok && spec.tests.every((t) => t.status === 'expected' || t.status === 'flaky')),
  }));
  const durationMs = Math.round(
    specs
      .flatMap((s) => s.tests)
      .flatMap((t) => t.results ?? [])
      .reduce((sum, r) => sum + (r.duration ?? 0), 0),
  );
  groups.set(n, { checks, durationMs });
}

const data = JSON.parse(readFileSync(RESULTS, 'utf8'));
const now = new Date().toISOString();

// Aufsteigend melden, bis das erste Level fehlschlägt.
const processed = new Map();
let failed = false;
for (const n of levels) {
  if (failed) break;
  const { checks, durationMs } = groups.get(n);
  const status = checks.every((c) => c.ok) ? 'bestanden' : 'fehlgeschlagen';
  Object.assign(data.levels[n - 1], { status, checkedAt: now, durationMs, checks, metrics: {} });
  processed.set(n, status);
  if (status === 'fehlgeschlagen') failed = true;
}

// Kennzahlen, nachdem der Status aller geprüften Levels feststeht.
let tokens = {};
try {
  tokens = levelTokens([...processed].map(([level, status]) => ({ level, status })));
  if (Object.keys(tokens).length === 0) console.log('Verbrauch: kein Session-Protokoll mit Antworten gefunden');
} catch (err) {
  console.log(`Verbrauch nicht ermittelbar: ${err.message}`);
}
for (const n of processed.keys()) {
  if (tokens[n]) data.levels[n - 1].metrics.tokens = tokens[n];
}

const extra = await collectExtraMetrics(processed);
for (const [n, m] of extra) Object.assign(data.levels[n - 1].metrics, m);

// Levels oberhalb des kleinsten angegebenen Levels, die nicht geprüft wurden, werden zurückgesetzt.
for (let n = levels[0] + 1; n <= 10; n++) {
  if (processed.has(n)) continue;
  Object.assign(data.levels[n - 1], {
    status: failed ? 'gesperrt' : 'offen',
    checkedAt: null,
    durationMs: null,
    checks: [],
    metrics: {},
  });
}

data.run.updatedAt = now;
if (process.env.RUN_ID) data.run.id = process.env.RUN_ID;
writeFileSync(RESULTS, JSON.stringify(data, null, 2) + '\n');

for (const n of levels) {
  const lvl = data.levels[n - 1];
  const ok = lvl.checks.filter((c) => c.ok).length;
  console.log(
    lvl.checks.length > 0 ? `Level ${n}: ${lvl.status} (${ok}/${lvl.checks.length} Checks)` : `Level ${n}: ${lvl.status}`,
  );
}

let exitCode = failed ? 1 : 0;

// Meldet die verarbeiteten Levels aufsteigend; nach einem fehlgeschlagenen Level stoppt es.
async function reportTo(base, label) {
  for (const n of levels) {
    if (!processed.has(n)) break;
    const lvl = data.levels[n - 1];
    let res;
    try {
      res = await fetch(`${base}/api/levels/${n}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checks: lvl.checks, durationMs: lvl.durationMs, metrics: lvl.metrics }),
      });
    } catch (err) {
      console.log(`Meldung an ${label} für Level ${n} fehlgeschlagen: ${err.message}`);
      return false;
    }
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      console.log(`Meldung an ${label} für Level ${n} fehlgeschlagen: ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    console.log(`Level ${n} an ${label} gemeldet`);
    if (lvl.status === 'fehlgeschlagen') break;
  }
  return true;
}

if (process.env.REPORT_API === '1') {
  const backendOk = await reportTo(process.env.API_URL ?? 'http://127.0.0.1:8081', 'das Backend');
  if (!backendOk) exitCode = 1;
  else if (process.env.REPORT_LIVE === '1' && !(await reportTo(process.env.LIVE_URL, 'die Live-API'))) exitCode = 1;
}

process.exitCode = exitCode;

// Kennzahlen der Levels 6, 7 und 9 (spec/05-datenmodell.md, „Kennzahlen pro Level“).
async function collectExtraMetrics(processedMap) {
  const out = new Map();
  const repo = process.env.GITHUB_REPO;
  const needsRemote = [6, 7].some((n) => processedMap.get(n) === 'bestanden');
  let sha = null;
  if (needsRemote) {
    try {
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch (err) {
      console.log(`Commit nicht ermittelbar: ${err.message}`);
    }
  }
  if (processedMap.get(6) === 'bestanden' && repo && sha) {
    try {
      out.set(6, { pipeline: pipelineOf(repo, sha) });
    } catch (err) {
      console.log(`Pipeline-Dauer nicht ermittelbar: ${err.message}`);
    }
  }
  if (processedMap.get(7) === 'bestanden' && repo && sha) {
    try {
      const frontendMB = await imageSizeMB(`${repo}-frontend`, sha);
      const backendMB = await imageSizeMB(`${repo}-backend`, sha);
      out.set(7, { images: { frontendMB, backendMB } });
    } catch (err) {
      console.log(`Image-Größen nicht ermittelbar: ${err.message}`);
    }
  }
  if (processedMap.get(9) === 'bestanden') {
    const file = path.join(CHECKS, '.out', 'loadtest.json');
    if (existsSync(file)) out.set(9, { loadtest: JSON.parse(readFileSync(file, 'utf8')) });
    else console.log('Lasttest nicht ermittelbar: checks/.out/loadtest.json fehlt');
  }
  return out;
}
