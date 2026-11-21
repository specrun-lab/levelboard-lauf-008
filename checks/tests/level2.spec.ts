import { test, expect } from '@playwright/test';

const GZIP = { 'Accept-Encoding': 'gzip' };

// Erste JS-Datei unter /assets/, die in index.html verlinkt ist.
async function firstAssetPath(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const html = await (await request.get('/')).text();
  const match = html.match(/src="(\/assets\/[^"]+\.js)"/);
  if (!match) throw new Error('keine JS-Datei unter /assets/ in index.html gefunden');
  return match[1];
}

test.describe('level-2', () => {
  test('Antwort kommt von nginx', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expect(res.headers()['server']).toBe('nginx');
  });

  test('results.json wird nicht zwischengespeichert', async ({ request }) => {
    const res = await request.get('/results.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  test('index.html wird nicht zwischengespeichert', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['cache-control']).toBe('no-cache');
  });

  test('Assets werden ein Jahr zwischengespeichert', async ({ request }) => {
    const path = await firstAssetPath(request);
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test('Fehlende Datei ergibt 404', async ({ request }) => {
    const res = await request.get('/gibt-es-nicht.json');
    expect(res.status()).toBe(404);
  });

  test('Antworten sind gzip-komprimiert', async ({ request }) => {
    const js = await firstAssetPath(request);
    for (const path of ['/', js, '/results.json']) {
      const res = await request.get(path, { headers: GZIP });
      expect(res.headers()['content-encoding'], path).toBe('gzip');
    }
  });

  test('Seite funktioniert über nginx', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    await page.goto('/');
    const board = page.getByTestId('board');
    await expect(board).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('level-card')).toHaveCount(10);
    expect(problems).toEqual([]);
  });
});
