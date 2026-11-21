import {
  Level,
  STATUS_LABELS,
  TITLES,
  TokenMetric,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatUsd,
  pad2,
  tokenOf,
} from '../results';

function costText(tok: TokenMetric | null): string {
  if (!tok) return '–';
  if (tok.kind === 'inLevel') return `in L${pad2(tok.level)}`;
  return formatUsd(tok.usage.costUsd);
}

function outputText(tok: TokenMetric | null): string {
  if (!tok || tok.kind !== 'usage') return '–';
  return formatNumber(tok.usage.output);
}

function Fact({ label, testId, value }: { label: string; testId: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

export function LevelCard({ level }: { level: Level }) {
  const tok = tokenOf(level.metrics);
  const passed = level.checks.filter((c) => c.ok).length;
  return (
    <article className={`card status-${level.status}`} data-testid="level-card" data-level={level.level} data-status={level.status}>
      <div className="card-head">
        <span className="card-num">L{pad2(level.level)}</span>
        <span className="badge" data-testid="level-status">
          <span className="dot" aria-hidden="true" />
          {STATUS_LABELS[level.status]}
        </span>
      </div>
      <h2 className="card-title" data-testid="level-title">
        {TITLES[level.level - 1]}
      </h2>
      <dl className="facts">
        <Fact label="Geprüft" testId="level-checked-at" value={formatDateTime(level.checkedAt)} />
        <Fact label="Dauer" testId="level-duration" value={formatDuration(level.durationMs)} />
        <Fact
          label="Checks"
          testId="level-checks"
          value={level.checks.length > 0 ? `${passed}/${level.checks.length}` : '–'}
        />
        <Fact label="Kosten" testId="level-cost" value={costText(tok)} />
        <Fact label="Ausgabe" testId="level-output" value={outputText(tok)} />
      </dl>
    </article>
  );
}
