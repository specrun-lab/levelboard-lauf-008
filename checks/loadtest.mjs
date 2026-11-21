// Lasttest gegen die Live-Seite (spec/levels/level-09.md). Nur fetch und performance.now().
// Aufruf: node loadtest.mjs <basis-url>
import { pathToFileURL } from 'node:url';

const CONNECTIONS = 10;
const DURATION_S = 30;
const TIMEOUT_MS = 10_000;

const nearestRank = (sorted, p) => sorted[Math.ceil((p / 100) * sorted.length) - 1];

export async function loadtest(base) {
  const start = performance.now();
  const end = start + DURATION_S * 1000;
  const times = [];
  let errors = 0;

  async function connection() {
    let k = 0;
    while (performance.now() < end) {
      const path = k % 2 === 0 ? '/' : '/api/levels';
      k++;
      const t0 = performance.now();
      let failed = false;
      try {
        const res = await fetch(base + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        await res.text();
        if (res.status !== 200) failed = true;
      } catch {
        failed = true;
      }
      times.push(performance.now() - t0);
      if (failed) errors++;
    }
  }

  await Promise.all(Array.from({ length: CONNECTIONS }, () => connection()));
  const elapsedS = (performance.now() - start) / 1000;
  const sorted = [...times].sort((a, b) => a - b);

  return {
    connections: CONNECTIONS,
    durationS: DURATION_S,
    requests: times.length,
    errors,
    rps: Math.round((times.length / elapsedS) * 10) / 10,
    p50Ms: sorted.length ? Math.round(nearestRank(sorted, 50)) : 0,
    p95Ms: sorted.length ? Math.round(nearestRank(sorted, 95)) : 0,
    maxMs: sorted.length ? Math.round(sorted[sorted.length - 1]) : 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!base) {
    console.error('Aufruf: node loadtest.mjs <basis-url>');
    process.exit(2);
  }
  console.log(JSON.stringify(await loadtest(base), null, 2));
}
