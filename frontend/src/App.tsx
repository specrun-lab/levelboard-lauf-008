import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { LevelCard } from './components/LevelCard';
import { Notice } from './components/Notice';
import { Report } from './components/Report';
import { Summary } from './components/Summary';
import { DataState, Loaded, Source, emptyLevels, loadApi, loadFile, loadSource } from './results';

export default function App() {
  const [source, setSource] = useState<Source | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading', data: null });

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    // API-Modus: alle 5 s neu abrufen; der nächste Abruf startet nach dem Ende des vorigen.
    const poll = async (): Promise<void> => {
      const next = await loadApi();
      if (!active) return;
      setLoaded(next);
      timer = window.setTimeout(() => {
        void poll();
      }, 5000);
    };

    void (async () => {
      const src = await loadSource();
      if (!active) return;
      setSource(src);
      if (src === 'api') {
        await poll();
      } else {
        const next = await loadFile();
        if (active) setLoaded(next);
      }
    })();

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const data = loaded.data;
  const levels = data ? data.levels : emptyLevels();
  const state: DataState = loaded.state;
  const showNotice = state === 'missing' || state === 'invalid' || state === 'unavailable';

  return (
    <div className="app" data-testid="board" data-state={state}>
      <Header run={data?.run ?? null} source={source} />
      <main className="main">
        {showNotice ? <Notice kind={state} /> : null}
        <Summary levels={levels} updatedAt={data?.run.updatedAt ?? null} />
        <section aria-label="Levels" className="grid">
          {levels.map((level) => (
            <LevelCard key={level.level} level={level} />
          ))}
        </section>
        <Report levels={levels} run={data?.run ?? null} />
      </main>
    </div>
  );
}
