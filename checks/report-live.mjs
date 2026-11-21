// Meldet den Gesamtstand an die Live-API (spec/levels/level-08.md).
// Aufruf: node report-live.mjs <results.json> <basis-url>
import { readFileSync } from 'node:fs';

const [file, base] = process.argv.slice(2);
if (!file || !base) {
  console.error('Aufruf: node report-live.mjs <results.json> <basis-url>');
  process.exit(2);
}

const data = JSON.parse(readFileSync(file, 'utf8'));
let reported = 0;
for (const lvl of [...data.levels].sort((a, b) => a.level - b.level)) {
  if (!['bestanden', 'fehlgeschlagen'].includes(lvl.status) || lvl.checks.length === 0) break;
  const res = await fetch(`${base}/api/levels/${lvl.level}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checks: lvl.checks, durationMs: lvl.durationMs }),
  });
  if (res.status < 200 || res.status >= 300) {
    console.error(`Meldung für Level ${lvl.level} fehlgeschlagen: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Level ${lvl.level} an die Live-API gemeldet`);
  reported++;
  if (lvl.status === 'fehlgeschlagen') break;
}
if (reported === 0) {
  console.error('Nichts gemeldet');
  process.exit(1);
}
