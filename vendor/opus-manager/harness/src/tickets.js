// Tickets are Markdown files with a small front-matter block. The directory a ticket
// sits in is its state; moving it with rename() is the lock (atomic on one volume).
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { ensureDir, writeFileAtomic, OmhError, nowIso } from './util.js';

export const STATES = ['open', 'doing', 'done', 'blocked', 'dropped'];

// ---------- front matter (tiny YAML subset: key: value, [a, b], numbers, booleans) ----------

function parseScalar(v) {
  const s = v.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => parseScalar(x)).filter((x) => x !== null);
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function fmtScalar(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `[${v.map(fmtScalar).join(', ')}]`;
  if (typeof v === 'string') {
    if (v === '' || /^[\s\[\]{}#&*!|>'"%@`]|: |\s$|^(true|false|null|-?\d+(\.\d+)?)$|,/.test(v)) return JSON.stringify(v);
    return v;
  }
  return String(v);
}

export function parseTicketText(text) {
  const norm = text.replace(/^﻿/, '');
  const m = norm.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  let body = norm;
  if (m) {
    body = norm.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (kv) fm[kv[1]] = parseScalar(kv[2]);
    }
  } else {
    // legacy opus-manager header: "> workdir: x" / "> claimed-by: y"
    for (const line of norm.split(/\r?\n/).slice(0, 12)) {
      const kv = line.match(/^>\s*(workdir|claimed-by)\s*:\s*(.*)$/);
      if (kv) fm[kv[1] === 'claimed-by' ? 'claimed_by' : kv[1]] = parseScalar(kv[2]);
    }
  }
  const title = (body.match(/^#\s+(.+)$/m) || [])[1]?.trim();
  return { fm, body, title };
}

export function serializeTicket(fm, body) {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${fmtScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

// ---------- lookup ----------

export function ticketIdOf(name) {
  const m = name.match(/^(T\d+[a-z]*)/i);
  return m ? m[1] : name.replace(/\.md$/, '');
}

function listState(root, state) {
  const dir = paths(root).state(state);
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

export function loadTicket(root, state, file) {
  const full = path.join(paths(root).state(state), file);
  const text = fs.readFileSync(full, 'utf8');
  const { fm, body, title } = parseTicketText(text);
  const name = file.replace(/\.md$/, '');
  return { id: fm.id || ticketIdOf(name), name, state, path: full, fm, body, title: fm.title || title || name };
}

export function listTickets(root, states = STATES) {
  const out = [];
  for (const s of states) for (const f of listState(root, s)) out.push(loadTicket(root, s, f));
  return out;
}

export function findTicket(root, ref) {
  const want = String(ref).replace(/\.md$/, '');
  const all = listTickets(root);
  const exact = all.filter((t) => t.name === want || t.id.toLowerCase() === want.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    // same id in several states should not happen; prefer the live one
    return exact.find((t) => t.state === 'doing') || exact[0];
  }
  throw new OmhError(`ticket "${ref}" not found in _tickets/{${STATES.join(',')}}`, 'E_TICKET');
}

export function updateTicketFm(t, patch) {
  const text = fs.readFileSync(t.path, 'utf8');
  const { fm, body } = parseTicketText(text);
  const next = { ...fm, ...patch };
  if (!('id' in fm)) next.id = t.id;
  writeFileAtomic(t.path, serializeTicket(next, body));
  t.fm = next;
  return t;
}

// rename() is the lock: if two dispatchers race, only one rename succeeds.
export function moveTicket(root, t, toState) {
  if (!STATES.includes(toState)) throw new OmhError(`bad state "${toState}"`, 'E_STATE');
  if (t.state === toState) return t;
  const destDir = ensureDir(paths(root).state(toState));
  const dest = path.join(destDir, path.basename(t.path));
  if (fs.existsSync(dest)) throw new OmhError(`${path.basename(dest)} already exists in ${toState}/`, 'E_LOCK');
  try {
    fs.renameSync(t.path, dest);
  } catch (e) {
    throw new OmhError(`could not move ${t.name} ${t.state}→${toState} (${e.code}); someone else probably claimed it`, 'E_LOCK');
  }
  return { ...t, state: toState, path: dest };
}

// ---------- dependencies / readiness ----------

export function depsOf(t) {
  const d = t.fm.depends ?? t.fm.deps;
  if (!d) return [];
  return (Array.isArray(d) ? d : [d]).map(String);
}

export function readyTickets(root) {
  const all = listTickets(root);
  const finished = new Set(all.filter((t) => t.state === 'done' || t.state === 'dropped').map((t) => t.id.toLowerCase()));
  return all
    .filter((t) => t.state === 'open')
    .map((t) => {
      const waiting = depsOf(t).filter((d) => !finished.has(d.toLowerCase()));
      return { ...t, waitingOn: waiting, ready: waiting.length === 0 };
    })
    .sort((a, b) => (b.fm.priority ?? 0) - (a.fm.priority ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function nextTicketNumber(root) {
  let max = 0;
  for (const s of STATES) for (const f of listState(root, s)) {
    const m = f.match(/^T(\d+)/i);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// ---------- acceptance checks ----------

// Commands are the backticked items in the numbered list under "## 验收" / "## Acceptance".
export function parseChecks(body) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let inSec = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSec = /^##\s*(验收|acceptance|checks)/i.test(line);
      continue;
    }
    if (!inSec) continue;
    const m = line.match(/^\s*\d+[.)、]\s*`([^`]+)`(.*)$/);
    if (m) out.push({ cmd: m[1].trim(), expect: m[2].replace(/^\s*(→|->|=>|:|：)\s*/, '').trim() });
  }
  return out;
}

export function allowedFiles(t) {
  const f = t.fm.files ?? t.fm.allow;
  if (!f) return null;
  return Array.isArray(f) ? f.map(String) : [String(f)];
}

// ---------- creation ----------

export function createTicket(root, { slug, title, kind, depends, files, workdir, worker, lang = 'zh', templateText }) {
  const n = nextTicketNumber(root);
  const id = `T${n}`;
  const safe = (slug || 'task').replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
  const name = `${id}-${safe}`;
  const fm = {
    id,
    title: title || safe,
    kind: kind || 'default',
    depends: depends?.length ? depends : undefined,
    files: files?.length ? files : undefined,
    workdir: workdir || undefined,
    worker: worker || undefined,
    created: nowIso(),
  };
  const body = (templateText || '').replace(/<简短标题>|<short title>/g, fm.title).replace(/T<N>|T<编号>/g, id);
  const file = path.join(ensureDir(paths(root).state('open')), `${name}.md`);
  if (fs.existsSync(file)) throw new OmhError(`${name}.md already exists`, 'E_EXISTS');
  writeFileAtomic(file, serializeTicket(fm, body));
  return loadTicket(root, 'open', `${name}.md`);
}
