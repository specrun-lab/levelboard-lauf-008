import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = process.env.GITHUB_REPO ?? `specrun-lab/levelboard-${process.env.RUN_ID ?? 'lokal'}`;
const LIVE_URL = process.env.LIVE_URL ?? '';

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function gh(apiPath: string): any {
  return JSON.parse(run('gh', ['api', apiPath]));
}

test.describe('level-8', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let head = '';

  test('Job deploy des letzten Laufs ist grün', async () => {
    head = run('git', ['rev-parse', 'HEAD']).trim();
    const runs = gh(`repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&head_sha=${head}&per_page=1`);
    expect(runs.workflow_runs.length).toBeGreaterThan(0);
    const jobs = gh(`repos/${REPO}/actions/runs/${runs.workflow_runs[0].id}/jobs`).jobs;
    const deploy = jobs.find((j: { name: string }) => j.name === 'deploy');
    expect(deploy, 'Job deploy').toBeDefined();
    expect(deploy.conclusion).toBe('success');
  });

  test('Live-Seite antwortet über HTTPS', async ({ request, page }) => {
    expect(LIVE_URL.startsWith('https://')).toBe(true);
    const res = await request.get(`${LIVE_URL}/`);
    expect(res.status()).toBe(200);
    await page.goto(`${LIVE_URL}/`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('run-source')).toHaveAttribute('data-source', 'api');
  });

  test('Live-Seite meldet den aktuellen Commit', async ({ request, page }) => {
    const res = await request.get(`${LIVE_URL}/api/health`);
    expect(res.status()).toBe(200);
    expect((await res.json()).commit).toBe(head);
    await page.goto(`${LIVE_URL}/`);
    await expect(page.getByTestId('run-commit')).toHaveText(head.slice(0, 7));
  });

  test('Live-Seite zeigt die Ergebnisse der Pipeline', async ({ request }) => {
    const body = await (await request.get(`${LIVE_URL}/api/levels`)).json();
    expect(body.run.id).toBe(process.env.RUN_ID);
    for (let n = 1; n <= 5; n++) {
      expect(body.levels[n - 1].status, `Level ${n}`).toBe('bestanden');
    }
  });
});
