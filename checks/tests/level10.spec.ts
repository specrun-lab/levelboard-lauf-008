import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { levelTokens } from '../collect-tokens.mjs';
import { imageSizeMB, pipelineOf } from '../collect-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKS_OUT = path.join(ROOT, 'checks', '.out');
const LIVE = process.env.LIVE_URL ?? '';
const REPO = process.env.GITHUB_REPO ?? `specrun-lab/levelboard-${process.env.RUN_ID ?? 'lokal'}`;

const isUsage = (t: any) => t && typeof t === 'object' && typeof t.total === 'number';
const cost = (v: number) => `${(Math.round(v * 100) / 100).toFixed(2).replace('.', ',')} USD`;
const de = (n: number) => n.toLocaleString('de-CH');
const pad = (n: number) => String(n).padStart(2, '0');

function head(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Liefert /api/levels so, wie der Test es vorgibt; nur /api/levels wird ersetzt.
async function routeLevels(page: import('@playwright/test').Page, levels: unknown) {
  await page.route(
    (url) => new URL(url).pathname === '/api/levels',
    async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: await currentRun(), levels }) }),
  );
}

let cachedRun: unknown = null;
async function currentRun() {
  return cachedRun;
}

test.describe('level-10', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let bericht: { pipeline: any; images: any; loadtest: any; tokens: Record<string, any> };

  test('Alle Teile des Berichts sind vorhanden', async ({ request }) => {
    const sha = head();
    const pipeline = pipelineOf(REPO, sha);
    for (const job of ['check', 'images', 'deploy']) {
      expect(pipeline.jobs[job], `Job ${job}`).toBeGreaterThan(0);
    }
    const images = {
      frontendMB: await imageSizeMB(`${REPO}-frontend`, sha),
      backendMB: await imageSizeMB(`${REPO}-backend`, sha),
    };
    expect(images.frontendMB).toBeGreaterThan(0);
    expect(images.backendMB).toBeGreaterThan(0);

    const loadtest = JSON.parse(readFileSync(path.join(CHECKS_OUT, 'loadtest.json'), 'utf8'));
    expect(loadtest.requests).toBeGreaterThan(0);

    const all = Array.from({ length: 10 }, (_, i) => ({ level: i + 1, status: 'bestanden' }));
    const tokens = levelTokens(all);
    expect(Object.keys(tokens)).toHaveLength(10);

    bericht = { pipeline, images, loadtest, tokens };
    mkdirSync(CHECKS_OUT, { recursive: true });
    writeFileSync(path.join(CHECKS_OUT, 'bericht.json'), JSON.stringify(bericht, null, 2) + '\n');
    void request;
  });

  test('Vollständiger Bericht wird dargestellt', async ({ page, request }) => {
    const now = new Date().toISOString();
    const apiRun = await (await request.get(`${LIVE}/api/levels`)).json();
    cachedRun = apiRun.run;
    const levels = Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      const metrics: Record<string, unknown> = { tokens: bericht.tokens[n] };
      if (n === 6) metrics.pipeline = bericht.pipeline;
      if (n === 7) metrics.images = bericht.images;
      if (n === 9) metrics.loadtest = bericht.loadtest;
      return { level: n, title: apiRun.levels[i].title, status: 'bestanden', checkedAt: now, durationMs: 1000, checks: [{ name: 'x', ok: true }], metrics };
    });
    await routeLevels(page, levels);
    await page.goto(`${LIVE}/`);
    const report = page.getByTestId('report');
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    await expect(report).toHaveAttribute('data-complete', 'true');
    await expect(page.getByTestId('report-reached')).toHaveText('10 / 10');
    await expect(page.getByTestId('report-complete')).toHaveText('ja');

    const usages = Object.values(bericht.tokens).filter(isUsage) as any[];
    const totalCost = usages.reduce((s, u) => s + u.costUsd, 0);
    const totalOut = usages.reduce((s, u) => s + u.output, 0);
    await expect(page.getByTestId('report-cost')).toHaveText(cost(totalCost));
    await expect(page.getByTestId('report-tokens-output')).toHaveText(de(totalOut));
    await expect(page.getByTestId('report-p95')).toHaveText(`${bericht.loadtest.p95Ms} ms`);
    await expect(page.getByTestId('report-image-frontend')).toHaveText(
      `${bericht.images.frontendMB.toFixed(1).replace('.', ',')} MB`,
    );
    for (const job of ['check', 'images', 'deploy']) {
      await expect(page.getByTestId(`report-job-${job}`)).toHaveText(`${bericht.pipeline.jobs[job]} s`);
    }
    await expect(page.getByTestId('report-pipeline-link')).toHaveAttribute('href', bericht.pipeline.url);

    for (let n = 1; n <= 10; n++) {
      const card = page.locator(`[data-testid="level-card"][data-level="${n}"]`);
      const t = bericht.tokens[n];
      const expCost = isUsage(t) ? cost(t.costUsd) : t?.inLevel !== undefined ? `in L${pad(t.inLevel)}` : '–';
      const expOut = isUsage(t) ? de(t.output) : '–';
      await expect(card.getByTestId('level-cost')).toHaveText(expCost);
      await expect(card.getByTestId('level-output')).toHaveText(expOut);
    }
  });

  test('Teilbericht zeigt fehlende Teile', async ({ page, request }) => {
    const now = new Date().toISOString();
    const apiRun = await (await request.get(`${LIVE}/api/levels`)).json();
    cachedRun = apiRun.run;
    const usage = Object.values(bericht.tokens).find(isUsage);
    const levels = Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      if (n <= 2) {
        return { level: n, title: apiRun.levels[i].title, status: 'bestanden', checkedAt: now, durationMs: 1000, checks: [{ name: 'x', ok: true }], metrics: { tokens: usage } };
      }
      return { level: n, title: apiRun.levels[i].title, status: 'offen', checkedAt: null, durationMs: null, checks: [], metrics: {} };
    });
    await routeLevels(page, levels);
    await page.goto(`${LIVE}/`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    const report = page.getByTestId('report');
    await expect(report).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('report-reached')).toHaveText('2 / 10');
    await expect(page.getByTestId('report-complete')).toHaveText('nein');
    await expect(page.getByTestId('report-pipeline-missing')).toHaveText('noch nicht erreicht');
    await expect(page.getByTestId('report-images-missing')).toHaveText('noch nicht erreicht');
    await expect(page.getByTestId('report-loadtest-missing')).toHaveText('noch nicht erreicht');
    await expect(page.getByTestId('report-tokens-missing')).toHaveCount(0);
  });
});
