import { test, expect } from '@playwright/test';

// Nachprüfung nach der Meldung an die Live-API (kein eigenes Level).
const LIVE = process.env.LIVE_URL ?? '';
const cost = (v: number) => `${(Math.round(v * 100) / 100).toFixed(2).replace('.', ',')} USD`;

test.describe('live-bericht', () => {
  test('Live-Seite zeigt den gemeldeten Abschlussbericht', async ({ page, request }) => {
    const api = await (await request.get(`${LIVE}/api/levels`)).json();
    expect(api.levels).toHaveLength(10);
    for (const l of api.levels) {
      expect(l.status, `Level ${l.level}`).toBe('bestanden');
      expect(l.metrics.tokens, `tokens Level ${l.level}`).toBeDefined();
    }
    expect(api.levels[5].metrics.pipeline).toBeDefined();
    expect(api.levels[6].metrics.images).toBeDefined();
    expect(api.levels[8].metrics.loadtest).toBeDefined();

    const usages = api.levels.map((l: any) => l.metrics.tokens).filter((t: any) => typeof t.total === 'number');
    const totalCost = usages.reduce((s: number, t: any) => s + t.costUsd, 0);

    await page.goto(`${LIVE}/`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('report')).toHaveAttribute('data-complete', 'true');
    await expect(page.getByTestId('summary-reached')).toHaveText('10 / 10');
    await expect(page.getByTestId('report-score')).toHaveText('100 / 100');
    await expect(page.getByTestId('report-commit')).toHaveText(api.run.commit.slice(0, 7));
    await expect(page.getByTestId('report-cost')).toHaveText(cost(totalCost));
    await expect(page.getByTestId('report-p95')).toHaveText(`${api.levels[8].metrics.loadtest.p95Ms} ms`);
    await expect(page.getByTestId('report-image-backend')).toHaveText(
      `${api.levels[6].metrics.images.backendMB.toFixed(1).replace('.', ',')} MB`,
    );
    await expect(page.getByTestId('report-pipeline-total')).toHaveText(
      `${api.levels[5].metrics.pipeline.totalS} s`,
    );
    const rows = page.getByTestId('report-level');
    await expect(rows).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-status', 'bestanden');
    }
  });
});
