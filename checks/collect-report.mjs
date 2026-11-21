// Kennzahlen für Level 6 (Pipeline) und Level 7 (Image-Größen), siehe spec/05-datenmodell.md.
import { execFileSync } from 'node:child_process';

function gh(apiPath) {
  return JSON.parse(execFileSync('gh', ['api', apiPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

// Lauf von „CI“ für sha auf main: { runId, url, jobs, totalS }.
export function pipelineOf(repo, sha) {
  const runs = gh(`repos/${repo}/actions/workflows/ci.yml/runs?branch=main&head_sha=${sha}&per_page=1`);
  const run = runs.workflow_runs?.[0];
  if (!run) throw new Error(`kein CI-Lauf für ${sha} auf main`);
  const { jobs: list } = gh(`repos/${repo}/actions/runs/${run.id}/jobs`);
  const jobs = {};
  let latest = 0;
  for (const j of list) {
    if (!j.completed_at) continue;
    jobs[j.name] = Math.round((Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000);
    latest = Math.max(latest, Date.parse(j.completed_at));
  }
  const totalS = Math.round((latest - Date.parse(run.run_started_at)) / 1000);
  return { runId: run.id, url: run.html_url, jobs, totalS };
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// Summe der Layer-Größen von ghcr.io/<name>:<tag> ohne Anmeldung, in MB (1 Nachkommastelle).
export async function imageSizeMB(name, tag) {
  const tokenRes = await fetch(`https://ghcr.io/token?scope=repository:${name}:pull`);
  if (!tokenRes.ok) throw new Error(`GHCR-Token: ${tokenRes.status}`);
  const { token } = await tokenRes.json();
  const getManifest = async (ref) => {
    const res = await fetch(`https://ghcr.io/v2/${name}/manifests/${ref}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    });
    if (!res.ok) throw new Error(`GHCR-Manifest ${name}:${ref}: ${res.status}`);
    return res.json();
  };
  let manifest = await getManifest(tag);
  if (manifest.manifests) {
    const entry = manifest.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
    if (!entry) throw new Error(`${name}: kein linux/amd64-Eintrag`);
    manifest = await getManifest(entry.digest);
  }
  const bytes = manifest.layers.reduce((sum, l) => sum + l.size, 0);
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}
