import { Level, STATUS_LABELS, formatDateTime, reachedLevel } from '../results';

export function Summary({ levels, updatedAt }: { levels: Level[]; updatedAt: string | null }) {
  const reached = reachedLevel(levels);
  return (
    <section className="summary" aria-label="Zusammenfassung">
      <div className="summary-left">
        <div className="label-caps">Erreichtes Level</div>
        <div className="reached" data-testid="summary-reached">
          {reached} <span className="of">/ 10</span>
        </div>
      </div>
      <div className="summary-right">
        <div className="progress" data-testid="summary-progress" role="img" aria-label={`${reached} von 10 Levels erreicht`}>
          {levels.map((l) => (
            <span
              key={l.level}
              className={`seg status-${l.status}`}
              title={`Level ${l.level}: ${STATUS_LABELS[l.status]}`}
            />
          ))}
        </div>
        <div className="updated">
          Zuletzt aktualisiert: <span data-testid="summary-updated">{updatedAt ? formatDateTime(updatedAt) : '–'}</span>
        </div>
      </div>
    </section>
  );
}
