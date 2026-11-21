import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = process.env.GITHUB_REPO ?? `specrun-lab/levelboard-${process.env.RUN_ID ?? 'lokal'}`;

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function gh(apiPath: string): any {
  return JSON.parse(run('gh', ['api', apiPath]));
}
function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry === name) {
      return p;
    }
  }
  return null;
}

test.describe('level-6', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let runId: number | undefined;

  test('Repo existiert und ist öffentlich', async () => {
    const repo = gh(`repos/${REPO}`);
    expect(repo.full_name).toBe(REPO);
    expect(repo.visibility).toBe('public');
    expect(repo.default_branch).toBe('main');
  });

  test('Lokaler Stand ist gepusht', async () => {
    expect(run('git', ['status', '--porcelain']).trim()).toBe('');
    const head = run('git', ['rev-parse', 'HEAD']).trim();
    const branch = gh(`repos/${REPO}/branches/main`);
    expect(head).toBe(branch.commit.sha);
  });

  test('Letzter Pipeline-Lauf ist grün', async () => {
    const head = run('git', ['rev-parse', 'HEAD']).trim();
    const runs = gh(`repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&head_sha=${head}&per_page=1`);
    expect(runs.workflow_runs.length).toBeGreaterThan(0);
    const last = runs.workflow_runs[0];
    expect(last.status).toBe('completed');
    expect(last.conclusion).toBe('success');
    runId = last.id;
  });

  test('Report enthält Level 1–5 bestanden', async () => {
    expect(runId).toBeDefined();
    const dir = path.join(ROOT, 'checks', '.out', `report-${runId}`);
    mkdirSync(dir, { recursive: true });
    const target = mkdtempSync(path.join(dir, 'dl-'));
    run('gh', ['run', 'download', String(runId), '--repo', REPO, '--name', 'levelboard-report', '--dir', target]);
    const file = findFile(target, 'results.json');
    expect(file, 'results.json im Artefakt').not.toBeNull();
    const data = JSON.parse(readFileSync(file as string, 'utf8'));
    for (let n = 1; n <= 5; n++) {
      const level = data.levels[n - 1];
      expect(level.level).toBe(n);
      expect(level.status, `Level ${n}`).toBe('bestanden');
      expect(level.checks.length, `Checks Level ${n}`).toBeGreaterThan(0);
    }
  });
});
