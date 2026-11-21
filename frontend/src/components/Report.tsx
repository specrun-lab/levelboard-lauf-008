import type { ReactNode } from 'react';
import {
  Level,
  Run,
  STATUS_LABELS,
  TITLES,
  Usage,
  formatDateTime,
  formatDecimal,
  formatNumber,
  formatUsd,
  isObject,
  pad2,
  reachedLevel,
  tokenOf,
} from '../results';

type Obj = Record<string, unknown>;

// Kennzahl eines Levels, z. B. metrics.pipeline von Level 6.
function metric(level: Level | undefined, key: string): Obj | null {
  const value = level?.metrics[key];
  return isObject(value) ? value : null;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function Row({ label, testId, value }: { label: string; testId: string; value: string }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

function Tile({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="tile">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Missing({ part }: { part: string }) {
  return (
    <p className="tile-missing" data-testid={`report-${part}-missing`}>
      noch nicht erreicht
    </p>
  );
}

export function Report({ levels, run }: { levels: Level[]; run: Run | null }) {
  const complete = levels[9]?.status === 'bestanden';

  // Leer, solange kein Level geprüft ist.
  if (!levels.some((l) => l.checkedAt !== null)) {
    return (
      <section className="report" aria-label="Abschlussbericht" data-testid="report" data-state="empty" data-complete={String(complete)}>
        <h2 className="report-title">Abschlussbericht</h2>
        <p className="muted-text" data-testid="report-empty">
          Noch kein Abschlussbericht – er erscheint, sobald das erste Level geprüft ist.
        </p>
      </section>
    );
  }

  const reached = reachedLevel(levels);
  const usages: Usage[] = [];
  for (const l of levels) {
    const tok = tokenOf(l.metrics);
    if (tok?.kind === 'usage') usages.push(tok.usage);
  }
  const sum = (f: (u: Usage) => number): number => usages.reduce((s, u) => s + f(u), 0);
  const models = [...new Set(usages.flatMap((u) => u.models))].sort();
  const costUsd = Math.round(sum((u) => u.costUsd) * 100) / 100;

  const loadtest = metric(levels[8], 'loadtest');
  const images = metric(levels[6], 'images');
  const pipeline = metric(levels[5], 'pipeline');
  const jobs: Obj = pipeline && isObject(pipeline.jobs) ? pipeline.jobs : {};
  const jobText = (name: string): string => (typeof jobs[name] === 'number' ? `${jobs[name]} s` : '–');

  return (
    <section className="report" aria-label="Abschlussbericht" data-testid="report" data-state="ready" data-complete={String(complete)}>
      <h2 className="report-title">Abschlussbericht</h2>
      <div className="tiles">
        <Tile title="Ergebnis">
          <dl className="tile-list">
            <Row label="Erreicht" testId="report-reached" value={`${reached} / 10`} />
            <Row label="Score" testId="report-score" value={`${reached * 10} / 100`} />
            <Row label="Vollständig" testId="report-complete" value={complete ? 'ja' : 'nein'} />
            <Row label="Commit" testId="report-commit" value={run?.commit ? run.commit.slice(0, 7) : '–'} />
            <Row label="Stand" testId="report-time" value={formatDateTime(run?.updatedAt ?? null)} />
          </dl>
        </Tile>

        <Tile title="Tokens">
          {usages.length === 0 ? (
            <Missing part="tokens" />
          ) : (
            <dl className="tile-list">
              <Row label="Modell" testId="report-model" value={models.join(', ')} />
              <Row label="Antworten" testId="report-responses" value={formatNumber(sum((u) => u.responses))} />
              <Row label="Eingabe" testId="report-tokens-input" value={formatNumber(sum((u) => u.input))} />
              <Row
                label="Cache schreiben"
                testId="report-tokens-cache-write"
                value={formatNumber(sum((u) => u.cacheWrite5m + u.cacheWrite1h))}
              />
              <Row label="Cache lesen" testId="report-tokens-cache-read" value={formatNumber(sum((u) => u.cacheRead))} />
              <Row label="Ausgabe" testId="report-tokens-output" value={formatNumber(sum((u) => u.output))} />
              <Row label="Gesamt" testId="report-tokens-total" value={formatNumber(sum((u) => u.total))} />
              <Row label="Kosten (API-Preis)" testId="report-cost" value={formatUsd(costUsd)} />
            </dl>
          )}
        </Tile>

        <Tile title="Lasttest">
          {loadtest ? (
            <dl className="tile-list">
              <Row label="p50" testId="report-p50" value={`${num(loadtest.p50Ms)} ms`} />
              <Row label="p95" testId="report-p95" value={`${num(loadtest.p95Ms)} ms`} />
              <Row label="Durchsatz" testId="report-rps" value={`${formatDecimal(num(loadtest.rps))} Anfragen/s`} />
              <Row label="Fehler" testId="report-errors" value={String(num(loadtest.errors))} />
            </dl>
          ) : (
            <Missing part="loadtest" />
          )}
        </Tile>

        <Tile title="Images">
          {images ? (
            <dl className="tile-list">
              <Row label="Frontend" testId="report-image-frontend" value={`${formatDecimal(num(images.frontendMB))} MB`} />
              <Row label="Backend" testId="report-image-backend" value={`${formatDecimal(num(images.backendMB))} MB`} />
            </dl>
          ) : (
            <Missing part="images" />
          )}
        </Tile>

        <Tile title="Pipeline">
          {pipeline ? (
            <>
              <dl className="tile-list">
                <Row label="check" testId="report-job-check" value={jobText('check')} />
                <Row label="images" testId="report-job-images" value={jobText('images')} />
                <Row label="deploy" testId="report-job-deploy" value={jobText('deploy')} />
                <Row label="Gesamt" testId="report-pipeline-total" value={`${num(pipeline.totalS)} s`} />
              </dl>
              <a
                className="tile-link"
                data-testid="report-pipeline-link"
                href={String(pipeline.url)}
                target="_blank"
                rel="noreferrer"
              >
                Lauf ansehen
              </a>
            </>
          ) : (
            <Missing part="pipeline" />
          )}
        </Tile>
      </div>

      <ol data-testid="report-levels" className="rlist">
        {levels.map((l) => (
          <li key={l.level} className="rrow" data-testid="report-level" data-level={l.level} data-status={l.status}>
            <span>
              L{pad2(l.level)} {TITLES[l.level - 1]}
            </span>
            <span className={`rstatus st-${l.status}`}>{STATUS_LABELS[l.status]}</span>
            <span className="rtime">{formatDateTime(l.checkedAt)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
