import { test, expect, APIRequestContext } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:8081';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function history(request: APIRequestContext, level: number, limit = 50) {
  const res = await request.get(`${API}/api/levels/${level}/history?limit=${limit}`);
  expect(res.status()).toBe(200);
  return res.json();
}

async function report(request: APIRequestContext, level: number, ok: boolean, durationMs: number) {
  return request.post(`${API}/api/levels/${level}/result`, {
    headers: JSON_HEADERS,
    data: { checks: [{ name: 'Probe', ok }], durationMs },
  });
}

test.describe('level-4', () => {
  test.describe.configure({ mode: 'serial' });

  test('Meldungen erscheinen in der Historie, neueste zuerst', async ({ request }) => {
    expect((await report(request, 1, true, 101)).status()).toBe(200);
    expect((await report(request, 1, true, 102)).status()).toBe(200);
    const h = await history(request, 1);
    expect(h.level).toBe(1);
    expect(h.entries[0].durationMs).toBe(102);
    expect(h.entries[1].durationMs).toBe(101);
    expect(h.entries[0].id).toBeGreaterThan(h.entries[1].id);
    expect(h.entries[0].status).toBe('bestanden');
  });

  test('Historie begrenzt mit limit', async ({ request }) => {
    const one = await history(request, 1, 1);
    expect(one.entries).toHaveLength(1);
    for (const limit of [0, 501]) {
      const res = await request.get(`${API}/api/levels/1/history?limit=${limit}`);
      expect(res.status(), `limit=${limit}`).toBe(400);
    }
  });

  test('Daten überstehen einen Neustart des Backends', async ({ request }) => {
    const hBefore = await history(request, 1, 500);
    const lBefore = await (await request.get(`${API}/api/levels`)).json();
    execFileSync('make', ['restart-backend'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const hAfter = await history(request, 1, 500);
    const lAfter = await (await request.get(`${API}/api/levels`)).json();
    expect(hAfter).toEqual(hBefore);
    expect(lAfter).toEqual(lBefore);
  });

  test('Abgelehnte Meldungen landen nicht in der Historie', async ({ request }) => {
    expect((await report(request, 1, false, 5)).status()).toBe(200);
    const before = (await history(request, 2, 500)).entries.length;
    const res = await report(request, 2, true, 5);
    expect(res.status()).toBe(409);
    const after = (await history(request, 2, 500)).entries.length;
    expect(after).toBe(before);
  });

  test('Datenbank hat das vorgegebene Schema', async () => {
    const db = new DatabaseSync(path.join(ROOT, '.run', 'levelboard.db'), { readOnly: true });
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(1);
      const columns = (table: string) =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(columns('levels')).toEqual(['level', 'status', 'checked_at', 'duration_ms', 'checks', 'metrics']);
      expect(columns('reports')).toEqual([
        'id',
        'level',
        'status',
        'checked_at',
        'duration_ms',
        'checks',
        'metrics',
      ]);
      expect(columns('meta')).toEqual(['key', 'value']);
      const count = db.prepare('SELECT count(*) AS n FROM levels').get() as { n: number };
      expect(count.n).toBe(10);
    } finally {
      db.close();
    }
  });
});
