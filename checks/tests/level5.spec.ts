import { test, expect } from '@playwright/test';

const API = process.env.API_URL ?? 'http://127.0.0.1:8081';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

test.describe('level-5', () => {
  test.describe.configure({ mode: 'serial' });

  test('Seite liest aus dem Backend', async ({ page, request }) => {
    const cfg = await request.get('/config.json');
    expect(await cfg.json()).toEqual({ source: 'api' });

    await page.goto('/');
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    const source = page.getByTestId('run-source');
    await expect(source).toHaveAttribute('data-source', 'api');
    await expect(source).toHaveText('Backend');
  });

  test('nginx leitet /api/ an das Backend weiter', async ({ request }) => {
    const via = await request.get('/api/health');
    expect(via.status()).toBe(200);
    expect(via.headers()['content-type']).toBe('application/json');
    const direct = await request.get(`${API}/api/health`);
    expect(await via.text()).toBe(await direct.text());

    const missing = await request.get('/api/unbekannt');
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toEqual(expect.any(String));
  });

  test('Gemeldetes Ergebnis erscheint ohne Neuladen', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    const res = await request.post('/api/levels/1/result', {
      headers: JSON_HEADERS,
      data: { checks: [{ name: 'Live-Anzeige', ok: true }], durationMs: 4242 },
    });
    expect(res.status()).toBe(200);
    const card = page.getByTestId('level-card').first();
    await expect(card.getByTestId('level-duration')).toHaveText('4,2 s', { timeout: 8000 });
    await expect(card.getByTestId('level-status')).toHaveText('Bestanden');
  });

  test('Backend-Ausfall wird angezeigt', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');

    await page.route('**/api/levels', (route) =>
      route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' }),
    );
    await expect(page.getByTestId('notice')).toHaveAttribute('data-kind', 'unavailable', { timeout: 8000 });
    const cards = page.getByTestId('level-card');
    await expect(cards).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await expect(cards.nth(i).getByTestId('level-status')).toHaveText('Offen');
    }

    await page.unroute('**/api/levels');
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok', { timeout: 8000 });
    await expect(page.getByTestId('notice')).toHaveCount(0);
  });

  test('Meldungen über nginx landen in der Historie', async ({ request }) => {
    const res = await request.post('/api/levels/1/result', {
      headers: JSON_HEADERS,
      data: { checks: [{ name: 'Probe über nginx', ok: true }], durationMs: 5151 },
    });
    expect(res.status()).toBe(200);
    const hist = await (await request.get('/api/levels/1/history?limit=1')).json();
    expect(hist.entries[0]).toMatchObject({
      status: 'bestanden',
      durationMs: 5151,
      checks: [{ name: 'Probe über nginx', ok: true }],
    });
  });
});
