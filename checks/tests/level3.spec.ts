import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:8081';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const STATUSES = ['offen', 'bestanden', 'fehlgeschlagen', 'gesperrt'];

test.describe('level-3', () => {
  test.describe.configure({ mode: 'serial' });

  test('Backend antwortet auf /api/health', async ({ request }) => {
    const res = await request.get(`${API}/api/health`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/json');
    expect(await res.json()).toEqual({ status: 'ok', version: expect.any(String), commit: null });
  });

  test('GET /api/levels liefert alle 10 Levels im Schema', async ({ request }) => {
    const res = await request.get(`${API}/api/levels`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['levels', 'run']);
    expect(body.levels).toHaveLength(10);
    body.levels.forEach((l: { level: number; status: string; checks: unknown }, i: number) => {
      expect(l.level).toBe(i + 1);
      expect(STATUSES).toContain(l.status);
      expect(Array.isArray(l.checks)).toBe(true);
    });
  });

  test('Ergebnis melden setzt Status und Zeitpunkt', async ({ request }) => {
    const res = await request.post(`${API}/api/levels/1/result`, {
      headers: JSON_HEADERS,
      data: { checks: [{ name: 'Probe', ok: true }], durationMs: 10 },
    });
    expect(res.status()).toBe(200);
    const level = (await res.json()).levels[0];
    expect(level.status).toBe('bestanden');
    expect(Number.isNaN(Date.parse(level.checkedAt))).toBe(false);
    expect(level.durationMs).toBe(10);
  });

  test('Fehlschlag sperrt höhere Levels', async ({ request }) => {
    const res = await request.post(`${API}/api/levels/1/result`, {
      headers: JSON_HEADERS,
      data: { checks: [{ name: 'Probe', ok: false }], durationMs: 10 },
    });
    expect(res.status()).toBe(200);
    const levels = (await res.json()).levels;
    expect(levels[0].status).toBe('fehlgeschlagen');
    for (const l of levels.slice(1)) expect(l.status).toBe('gesperrt');
  });

  test('Falsche Reihenfolge ergibt 409', async ({ request }) => {
    const res = await request.post(`${API}/api/levels/2/result`, {
      headers: JSON_HEADERS,
      data: { checks: [{ name: 'Probe', ok: true }], durationMs: 10 },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toEqual(expect.any(String));
  });

  test('Ungültige Anfragen ergeben 400', async ({ request }) => {
    const bodies: (string | object)[] = ['{kaputt', { durationMs: 1 }, { checks: [], durationMs: 1 }];
    for (const data of bodies) {
      const res = await request.post(`${API}/api/levels/1/result`, { headers: JSON_HEADERS, data });
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect((await res.json()).error).toEqual(expect.any(String));
    }
  });

  test('Unbekanntes Level ergibt 404', async ({ request }) => {
    for (const n of ['0', '11', 'abc']) {
      const res = await request.get(`${API}/api/levels/${n}`);
      expect(res.status(), n).toBe(404);
    }
  });

  test('Go-Tests bestehen', async () => {
    execFileSync('go', ['test', '-count=1', './...'], {
      cwd: path.join(ROOT, 'backend'),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  });
});
