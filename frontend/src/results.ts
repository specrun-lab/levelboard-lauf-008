// Typen, Laden, Prüfen, Auswerten und Formatieren der Levelboard-Daten.
// Regeln: spec/05-datenmodell.md und results.schema.json.

export const STATUSES = ['offen', 'bestanden', 'fehlgeschlagen', 'gesperrt'] as const;
export type Status = (typeof STATUSES)[number];

export const TITLES = [
  'Statische Seite',
  'Webserver',
  'REST-Backend',
  'Datenbank',
  'Frontend + Backend',
  'Repo + CI',
  'Images in der Pipeline',
  'Deployment',
  'Live-Prüfung',
  'Metriken veröffentlicht',
] as const;

export const STATUS_LABELS: Record<Status, string> = {
  offen: 'Offen',
  bestanden: 'Bestanden',
  fehlgeschlagen: 'Fehlgeschlagen',
  gesperrt: 'Gesperrt',
};

export interface Check {
  name: string;
  ok: boolean;
}

export type Metrics = Record<string, unknown>;

export interface Level {
  level: number;
  title: string;
  status: Status;
  checkedAt: string | null;
  durationMs: number | null;
  checks: Check[];
  metrics: Metrics;
}

export interface Run {
  id: string;
  version: string;
  commit: string | null;
  updatedAt: string | null;
}

export interface Results {
  run: Run;
  levels: Level[];
}

export type DataState = 'loading' | 'ok' | 'missing' | 'invalid' | 'unavailable';
export type Source = 'file' | 'api';

export interface Loaded {
  state: DataState;
  data: Results | null;
}

type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasKeys(o: Obj, keys: string[]): boolean {
  const actual = Object.keys(o).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((k, i) => k === expected[i]);
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isDate = (v: unknown): boolean => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isNullOr = (v: unknown, ok: (x: unknown) => boolean): boolean => v === null || ok(v);

function parseLevel(v: unknown): Level | null {
  if (!isObject(v) || !hasKeys(v, ['level', 'title', 'status', 'checkedAt', 'durationMs', 'checks', 'metrics'])) {
    return null;
  }
  const { level, title, status, checkedAt, durationMs, checks, metrics } = v;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 10) return null;
  if (typeof title !== 'string') return null;
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) return null;
  if (!isNullOr(checkedAt, isDate)) return null;
  if (!isNullOr(durationMs, (d) => typeof d === 'number' && Number.isInteger(d) && d >= 0)) return null;
  if (!Array.isArray(checks)) return null;
  const parsedChecks: Check[] = [];
  for (const c of checks) {
    if (!isObject(c) || !hasKeys(c, ['name', 'ok']) || !isText(c.name) || typeof c.ok !== 'boolean') return null;
    parsedChecks.push({ name: c.name, ok: c.ok });
  }
  if (!isObject(metrics)) return null;
  return {
    level,
    title,
    status: status as Status,
    checkedAt: checkedAt as string | null,
    durationMs: durationMs as number | null,
    checks: parsedChecks,
    metrics,
  };
}

// Streng: jede Abweichung vom Schema macht die ganze Datei ungültig.
export function parseResults(value: unknown): Results | null {
  if (!isObject(value) || !hasKeys(value, ['run', 'levels'])) return null;
  const run = value.run;
  if (!isObject(run) || !hasKeys(run, ['id', 'version', 'commit', 'updatedAt'])) return null;
  if (!isText(run.id) || !isText(run.version)) return null;
  if (!isNullOr(run.commit, (c) => typeof c === 'string')) return null;
  if (!isNullOr(run.updatedAt, isDate)) return null;
  const raw = value.levels;
  if (!Array.isArray(raw) || raw.length !== 10) return null;
  const levels: Level[] = [];
  for (const item of raw) {
    const parsed = parseLevel(item);
    if (!parsed) return null;
    levels.push(parsed);
  }
  if (new Set(levels.map((l) => l.level)).size !== 10) return null;
  levels.sort((a, b) => a.level - b.level);
  return {
    run: {
      id: run.id,
      version: run.version,
      commit: run.commit as string | null,
      updatedAt: run.updatedAt as string | null,
    },
    levels,
  };
}

const isHtml = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('text/html');

async function readResults(res: Response): Promise<Results | null> {
  try {
    return parseResults(await res.json());
  } catch {
    return null;
  }
}

// Datei-Modus: einmalig /results.json laden.
export async function loadFile(): Promise<Loaded> {
  let res: Response;
  try {
    res = await fetch('/results.json', { cache: 'no-store' });
  } catch {
    return { state: 'missing', data: null };
  }
  if (res.status === 404) return { state: 'missing', data: null };
  if (!res.ok) return { state: 'invalid', data: null };
  if (isHtml(res)) return { state: 'missing', data: null };
  const data = await readResults(res);
  return data ? { state: 'ok', data } : { state: 'invalid', data: null };
}

// API-Modus: Gesamtstand vom Backend.
export async function loadApi(): Promise<Loaded> {
  let res: Response;
  try {
    res = await fetch('/api/levels', { cache: 'no-store' });
  } catch {
    return { state: 'unavailable', data: null };
  }
  if (!res.ok || isHtml(res)) return { state: 'unavailable', data: null };
  const data = await readResults(res);
  return data ? { state: 'ok', data } : { state: 'invalid', data: null };
}

// Welche Quelle die Einstellung im Build vorgibt. Im Zweifel: Datei.
export async function loadSource(): Promise<Source> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok || isHtml(res)) return 'file';
    const cfg: unknown = await res.json();
    return isObject(cfg) && cfg.source === 'api' ? 'api' : 'file';
  } catch {
    return 'file';
  }
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export function formatDateTime(iso: string | null): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${formatDecimal(ms / 1000)} s`;
}

export const formatDecimal = (n: number): string => n.toFixed(1).replace('.', ',');
export const formatNumber = (n: number): string => n.toLocaleString('de-CH');
export const formatUsd = (v: number): string => `${v.toFixed(2).replace('.', ',')} USD`;

export function reachedLevel(levels: Level[]): number {
  let n = 0;
  for (const l of levels) {
    if (l.level !== n + 1 || l.status !== 'bestanden') break;
    n = l.level;
  }
  return n;
}

export function emptyLevels(): Level[] {
  return TITLES.map((title, i) => ({
    level: i + 1,
    title,
    status: 'offen' as const,
    checkedAt: null,
    durationMs: null,
    checks: [],
    metrics: {},
  }));
}

export interface Usage {
  models: string[];
  responses: number;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  total: number;
  costUsd: number;
  from: string | null;
  until: string | null;
}

export type TokenMetric = { kind: 'usage'; usage: Usage } | { kind: 'inLevel'; level: number };

// metrics.tokens: entweder ein Token-Objekt oder { "inLevel": n }.
export function tokenOf(metrics: Metrics): TokenMetric | null {
  const t = metrics.tokens;
  if (!isObject(t)) return null;
  if (typeof t.inLevel === 'number') return { kind: 'inLevel', level: t.inLevel };
  if (typeof t.total === 'number') return { kind: 'usage', usage: t as unknown as Usage };
  return null;
}
