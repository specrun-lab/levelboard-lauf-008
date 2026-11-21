import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

// Lauf von „CI“ für den lokalen HEAD auf main.
function lastRunForHead(): any {
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const runs = gh(`repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&head_sha=${head}&per_page=1`);
  expect(runs.workflow_runs.length).toBeGreaterThan(0);
  return runs.workflow_runs[0];
}

test.describe('level-7', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test('Job images des letzten Laufs ist grün', async () => {
    const last = lastRunForHead();
    const jobs = gh(`repos/${REPO}/actions/runs/${last.id}/jobs`).jobs;
    const images = jobs.find((j: { name: string }) => j.name === 'images');
    expect(images, 'Job images').toBeDefined();
    expect(images.conclusion).toBe('success');
  });

  test('Beide Images liegen öffentlich in der GHCR', async ({ request }) => {
    const head = run('git', ['rev-parse', 'HEAD']).trim();
    for (const teil of ['frontend', 'backend']) {
      const name = `${REPO}-${teil}`;
      const tokenRes = await request.get(`https://ghcr.io/token?scope=repository:${name}:pull`);
      expect(tokenRes.status(), `Token ${teil}`).toBe(200);
      const { token } = await tokenRes.json();
      const manifest = await request.head(`https://ghcr.io/v2/${name}/manifests/${head}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: [
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json',
          ].join(', '),
        },
      });
      expect(manifest.status(), `Manifest ${teil}`).toBeGreaterThanOrEqual(200);
      expect(manifest.status(), `Manifest ${teil}`).toBeLessThan(300);
    }
  });

  test('Report der Container-Suite enthält nur bestandene Checks', async () => {
    const last = lastRunForHead();
    const dir = path.join(ROOT, 'checks', '.out', `container-${last.id}`);
    mkdirSync(dir, { recursive: true });
    const target = mkdtempSync(path.join(dir, 'dl-'));
    run('gh', ['run', 'download', String(last.id), '--repo', REPO, '--name', 'levelboard-container-report', '--dir', target]);
    const file = findFile(target, 'playwright.json');
    expect(file, 'playwright.json im Artefakt').not.toBeNull();
    const report = JSON.parse(readFileSync(file as string, 'utf8'));
    const tests: { status: string }[] = [];
    const walk = (suites: any[] = []) => {
      for (const s of suites) {
        for (const spec of s.specs ?? []) tests.push(...spec.tests);
        walk(s.suites);
      }
    };
    walk(report.suites);
    expect(tests.length).toBeGreaterThanOrEqual(6);
    expect(tests.filter((t) => t.status !== 'expected').length).toBe(0);
  });
});
