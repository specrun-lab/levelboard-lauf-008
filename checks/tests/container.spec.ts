import { test, expect, APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Läuft nur im Job „images“ der Pipeline, gegen docker compose im Projektordner.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function compose(args: string[]): string {
  return execFileSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function history(request: APIRequestContext) {
  const res = await request.get('/api/levels/1/history?limit=500');
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('container', () => {
  test.describe.configure({ mode: 'serial' });

  test('Seite läuft im Container und liest aus dem Backend', async ({ page, request }) => {
    expect(await (await request.get('/config.json')).json()).toEqual({ source: 'api' });
    await page.goto('/');
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('run-source')).toHaveAttribute('data-source', 'api');
  });

  test('/api/ wird an den Backend-Container weitergeleitet', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect(health.headers()['content-type']).toBe('application/json');
    expect((await health.json()).status).toBe('ok');
    const missing = await request.get('/api/unbekannt');
    expect(missing.status()).toBe(404);
  });

  test('Meldung erscheint ohne Neuladen', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    const res = await request.post('/api/levels/1/result', {
      headers: JSON_HEADERS,
      data: { checks: [{ name: 'Container-Probe', ok: true }], durationMs: 4242 },
    });
    expect(res.status()).toBe(200);
    await expect(page.getByTestId('level-card').first().getByTestId('level-duration')).toHaveText('4,2 s', {
      timeout: 8000,
    });
  });

  test('Daten überstehen einen Neustart des Backend-Containers', async ({ request }) => {
    const before = await history(request);
    expect(before.entries.length).toBeGreaterThan(0);
    compose(['restart', 'backend']);
    const deadline = Date.now() + 60_000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      try {
        healthy = (await request.get('/api/health')).status() === 200;
      } catch {
        healthy = false;
      }
      if (!healthy) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(healthy).toBe(true);
    expect(await history(request)).toEqual(before);
  });

  test('Cache- und gzip-Regeln gelten im Container', async ({ request }) => {
    const root = await request.get('/', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(root.headers()['cache-control']).toBe('no-cache');
    expect(root.headers()['content-encoding']).toBe('gzip');
    expect(root.headers()['server']).toBe('nginx');

    const html = await root.text();
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(js).not.toBeNull();
    const asset = await request.get(js![1]);
    expect(asset.headers()['cache-control']).toBe('public, max-age=31536000, immutable');

    expect((await request.get('/config.json')).headers()['cache-control']).toBe('no-store');
    expect((await request.get('/gibt-es-nicht.json')).status()).toBe(404);
  });

  test('Backend-Container läuft nicht als root', async () => {
    const uid = compose(['exec', '-T', 'backend', 'id', '-u']).trim();
    expect(uid).not.toBe('0');
  });
});
