// Job bookkeeping: status files, events log, liveness.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { readJson, appendLine, nowIso, isPidAlive, ensureDir } from './util.js';

export function jobFiles(root, ticket, phase, attempt = 1) {
  const p = paths(root);
  const id = ticket.id;
  const base = path.join(p.receipts, id);
  const isBuild = phase === 'build';
  return {
    status: `${base}.${phase}.json`,
    log: isBuild ? `${base}.build-a${attempt}.log` : `${base}.${phase}.log`,
    spec: path.join(p.jobs, `${id}.${phase}.spec.json`),
    receipt: path.join(p.receipts, `${ticket.name}.receipt.md`),
    report: isBuild ? null : `${base}.${phase}.md`,
    lastMessage: path.join(p.jobs, `${id}.${phase}.last.txt`),
    diff: `${base}.diff`,
    baseline: path.join(p.jobs, `${id}.baseline.json`),
  };
}

export function readStatus(file) {
  return readJson(file, null);
}

// How long a supervisor may go without a heartbeat before it counts as gone. Generous on
// purpose: a busy machine can delay timers; a real loss shows up within minutes anyway.
export function heartbeatStaleMs(st) {
  return Math.max(90 * 1000, 6 * (st.tickMs || 5000));
}

// A status that claims "running" but whose supervisor is gone is "lost". The heartbeat is
// the primary signal (works from another machine and survives PID reuse on Windows); the
// PID check covers the window before the first heartbeat.
export function effectiveState(st, now = Date.now()) {
  if (!st) return 'none';
  if (st.state === 'running' || st.state === 'starting') {
    if (st.heartbeatAt) {
      if (now - Date.parse(st.heartbeatAt) > heartbeatStaleMs(st)) return 'lost';
      return st.state;
    }
    if (st.supervisorPid && !isPidAlive(st.supervisorPid)) return 'lost';
  }
  return st.state;
}

export function allStatuses(root) {
  const dir = paths(root).receipts;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(build|review-\d+)\.json$/.test(f));
  } catch {}
  return files
    .map((f) => {
      const st = readStatus(path.join(dir, f));
      if (!st) return null;
      return { ...st, file: path.join(dir, f), effective: effectiveState(st) };
    })
    .filter(Boolean);
}

export function runningJobs(root) {
  return allStatuses(root).filter((s) => s.effective === 'running' || s.effective === 'starting');
}

export function logEvent(root, type, data = {}) {
  const p = paths(root);
  ensureDir(p.receipts);
  appendLine(p.events, JSON.stringify({ ts: nowIso(), type, ...data }));
}

export function readEvents(root) {
  try {
    return fs
      .readFileSync(paths(root).events, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function nextReviewRound(root, ticket) {
  const dir = paths(root).receipts;
  let n = 1;
  while (fs.existsSync(path.join(dir, `${ticket.id}.review-${n}.json`))) n++;
  return n;
}

// Spend comes from job-end events (status files are overwritten on retry; events are not).
export function spentUsd(root, filter = () => true) {
  return readEvents(root)
    .filter((e) => e.type === 'job-end' && filter(e))
    .reduce((sum, e) => sum + (e.usage?.costUsd || 0), 0);
}
