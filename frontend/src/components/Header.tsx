import { Run, Source } from '../results';

export function Header({ run, source }: { run: Run | null; source: Source | null }) {
  const sourceText = source === 'api' ? 'Backend' : source === 'file' ? 'Datei' : '–';
  return (
    <header className="header">
      <div className="brand">
        <span className="mark" aria-hidden="true">
          ▮▮▮
        </span>
        <span className="brand-name">Levelboard</span>
      </div>
      <dl className="run-meta">
        <div className="pair">
          <dt>Durchlauf</dt>
          <dd data-testid="run-id">{run?.id ?? '–'}</dd>
        </div>
        <div className="pair">
          <dt>Version</dt>
          <dd data-testid="run-version">{run?.version ?? '–'}</dd>
        </div>
        <div className="pair pair-optional">
          <dt>Commit</dt>
          <dd data-testid="run-commit" title={run?.commit ?? undefined}>
            {run?.commit ? run.commit.slice(0, 7) : '–'}
          </dd>
        </div>
        <div className="pair pair-optional">
          <dt>Quelle</dt>
          <dd data-testid="run-source" data-source={source ?? ''}>
            {sourceText}
          </dd>
        </div>
      </dl>
    </header>
  );
}
