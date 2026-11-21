// Verbrauch pro Level aus den Claude-Code-Session-Protokollen (spec/05-datenmodell.md, „Verbrauch pro Level“).
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// USD pro Million Tokens
export const PRICES = {
  'claude-opus-5-5': { input: 4, w5m: 5, w1h: 8, read: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, w5m: 2.5, w1h: 4, read: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, w5m: 0.125, w1h: 0.2, read: 0.01, output: 0.5 },
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function* jsonlFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function readEvents(dir) {
  const responses = [];
  const commands = new Map();
  const outputs = [];
  for (const file of jsonlFiles(dir)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const t = Date.parse(o.timestamp);
      const content = o.message?.content;
      if (o.type === 'assistant') {
        if (o.message?.usage && o.message.model !== '<synthetic>') {
          responses.push({ id: o.message.id, t, timestamp: o.timestamp, model: o.message.model, usage: o.message.usage });
        }
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'tool_use' && b.name === 'Bash') commands.set(b.id, b.input?.command ?? '');
          }
        }
      }
      if (o.type === 'user') {
        const tu = o.toolUseResult;
        if (tu && (typeof tu.stdout === 'string' || typeof tu.stderr === 'string') && Array.isArray(content)) {
          const tr = content.find((b) => b.type === 'tool_result');
          if (tr) outputs.push({ t, id: tr.tool_use_id, text: `${tu.stdout ?? ''}\n${tu.stderr ?? ''}` });
        }
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map((b) => b.text ?? '').join('\n')
              : '';
        if (text.includes('<task-notification>')) {
          const m = text.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
          if (m) outputs.push({ t, id: m[1], text });
        }
      }
    }
  }
  return { responses, commands, outputs };
}

// Jede message.id zählt nur einmal (die früheste Zeile gilt).
function dedupe(responses) {
  const sorted = [...responses].sort((a, b) => (a.t || 0) - (b.t || 0));
  const seen = new Set();
  const out = [];
  for (const r of sorted) {
    if (r.id) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
    }
    out.push(r);
  }
  return out;
}

function tokenObject(list) {
  const models = new Set();
  const sums = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  let cost = 0;
  for (const r of list) {
    const price = PRICES[r.model];
    if (!price) throw new Error(`unbekanntes Modell: ${r.model}`);
    const u = r.usage;
    const cc = u.cache_creation;
    const input = num(u.input_tokens);
    const w5 = cc ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens);
    const w1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
    const read = num(u.cache_read_input_tokens);
    const out = num(u.output_tokens);
    models.add(r.model);
    sums.input += input;
    sums.cacheWrite5m += w5;
    sums.cacheWrite1h += w1;
    sums.cacheRead += read;
    sums.output += out;
    cost += (input * price.input + w5 * price.w5m + w1 * price.w1h + read * price.read + out * price.output) / 1e6;
  }
  const total = sums.input + sums.cacheWrite5m + sums.cacheWrite1h + sums.cacheRead + sums.output;
  return {
    models: [...models].sort(),
    responses: list.length,
    input: sums.input,
    cacheWrite5m: sums.cacheWrite5m,
    cacheWrite1h: sums.cacheWrite1h,
    cacheRead: sums.cacheRead,
    output: sums.output,
    total,
    costUsd: Math.round(cost * 100) / 100,
    from: list[0]?.timestamp ?? null,
    until: list[list.length - 1]?.timestamp ?? null,
  };
}

function zeroObject() {
  return {
    models: [],
    responses: 0,
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    total: 0,
    costUsd: 0,
    from: null,
    until: null,
  };
}

// Höchstes n, für das „Level 1: bestanden“ … „Level n: bestanden“ in der Ausgabe stehen.
function passedUpTo(text) {
  let n = 0;
  while (text.includes(`Level ${n + 1}: bestanden`)) n++;
  return n;
}

// current: [{ level, status }] aller geprüften Levels dieses Laufs, aufsteigend.
// Ergebnis: { [level]: Token-Objekt | { inLevel: n } }; {} ohne Protokoll.
export function levelTokens(current, dir = path.join(os.homedir(), '.claude', 'projects')) {
  const { responses: raw, commands, outputs } = readEvents(dir);
  const responses = dedupe(raw);
  if (responses.length === 0) return {};

  // Phasengrenzen: Ausgaben von „make check“, nach Zeit sortiert.
  const checkOutputs = outputs
    .filter((o) => /make\s+check\b/.test(commands.get(o.id) ?? ''))
    .sort((a, b) => a.t - b.t);
  const boundaries = [];
  let best = 0;
  for (const o of checkOutputs) {
    const reached = passedUpTo(o.text);
    if (reached > best) {
      boundaries.push({ t: o.t, from: best + 1, to: reached });
      best = reached;
    }
  }

  const result = {};
  let prevT = -Infinity;
  for (const b of boundaries) {
    const list = responses.filter((r) => r.t > prevT && r.t <= b.t);
    for (let k = b.from; k < b.to; k++) result[k] = { inLevel: b.to };
    result[b.to] = tokenObject(list);
    prevT = b.t;
  }

  // Laufende Phase: nach der letzten Grenze.
  const running = responses.filter((r) => r.t > prevT);
  const status = new Map(current.map((c) => [c.level, c.status]));
  let reachedNow = 0;
  while (status.get(reachedNow + 1) === 'bestanden') reachedNow++;
  const failed = current.find((c) => c.status === 'fehlgeschlagen')?.level;

  if (reachedNow > best) {
    for (let k = best + 1; k < reachedNow; k++) result[k] = { inLevel: reachedNow };
    result[reachedNow] = tokenObject(running);
    if (failed !== undefined && failed > best) result[failed] = zeroObject();
  } else if (failed !== undefined && failed > best) {
    result[failed] = tokenObject(running);
  }
  return result;
}
