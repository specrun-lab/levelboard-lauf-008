import { test, expect } from '@playwright/test';

test.describe('level-1', () => {
  test('Seite antwortet mit HTTP 200', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
  });

  test('Titel ist „Levelboard“', async ({ page }) => {
    await page.goto('/');
    expect(await page.title()).toBe('Levelboard');
  });

  test('10 Level-Karten sichtbar', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="board"]:not([data-state="loading"])');
    const cards = page.getByTestId('level-card');
    await expect(cards).toHaveCount(10);
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i)).toBeVisible();
    }
  });

  test('Keine Konsolenfehler', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    await page.goto('/');
    await page.waitForSelector('[data-testid="board"]:not([data-state="loading"])');
    expect(problems).toEqual([]);
  });

  test('Handy-Ansicht: Karten einspaltig', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForSelector('[data-testid="board"]:not([data-state="loading"])');
    const cards = page.getByTestId('level-card');
    const xs = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
    expect(xs.length).toBe(10);
    expect(new Set(xs).size).toBe(1);
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
  });
});
