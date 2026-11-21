// The hand-off packet: everything a manager needs to accept one ticket, in one small
// object. Every field comes from a real file or from git; what the worker claims is kept
// apart from what the harness proved. The size cap is a budget rule: the point of this
// command is to save the manager's context, so it must stay cheaper than reading the
// receipt, the diff and the log separately.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { findTicket, parseChecks } from './tickets.js';
import { jobFiles, readStatus, effectiveState } from './jobs.js';
import { readJson, fileExists, humanDuration } from './util.js';
import { changeScope } from './core.js';

const MAX_CHARS = 6000;
const ACTIVE = new Set(['starting', 'running']);

const cut = (s, n) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
};
const rel = (root, file) => path.relative(root, file).replace(/\\/g, '/');

// ---------------------------------------------------------------- fields

function buildInfo(root, t) {
  const st = readStatus(jobFiles(root, t, 'build').status);
  if (!st) return { state: 'none', note: 'no build recorded; dispatch the ticket first' };
  const state = effectiveState(st);
  const out = { state, ok: st.ok ?? null, exitCode: st.exitCode ?? null };
  const took = st.durationMs ?? (st.endedAt && st.startedAt ? Date.parse(st.endedAt) - Date.parse(st.startedAt) : null);
  if (took != null) out.took = humanDuration(took);
  if (st.error) out.error = cut(st.error, 300);
  const u = st.usage || {};
  const usage = {};
  if (u.credits != null) usage.credits = u.credits;
  if (u.costUsd != null) usage.costUsd = Number(Number(u.costUsd).toFixed(4));
  const tokens = u.totalTokens ?? ((u.inputTokens || 0) + (u.outputTokens || 0) || null);
  if (tokens != null) usage.tokens = tokens;
  if (Object.keys(usage).length) out.usage = usage;
  return out;
}

// The commands the worker says it ran: the backticked items in section 3 of the receipt
// ("验收证据" / "Acceptance evidence"). These are claims, not evidence — verify is evidence.
function claimCommands(text) {
  const sec = text.split(/^##\s*3\b.*$/m)[1]?.split(/^##\s/m)[0] || '';
  const out = [];
  for (const m of sec.matchAll(/`([^`\n]+)`/g)) {
    const c = m[1].trim();
    if (c && !out.includes(c)) out.push(cut(c, 200));
    if (out.length >= 20) break;
  }
  return out;
}

function receiptInfo(root, t) {
  const file = jobFiles(root, t, 'build').receipt;
  if (!fileExists(file)) return { exists: false, path: rel(root, file), claims: [] };
  return {
    exists: true,
    path: rel(root, file),
    claimsNote: 'worker-declared, not evidence (verify below is the evidence)',
    claims: claimCommands(fs.readFileSync(file, 'utf8')),
  };
}

function verifyInfo(root, t) {
  const file = path.join(paths(root).receipts, `${t.id}.verify.json`);
  const v = readJson(file, null);
  if (!v) return { ran: false, note: `not verified: run omh verify ${t.id}` };
  // Evidence from an earlier attempt does not prove this attempt's code.
  const current = Number(t.fm.attempt) || 0;
  const verified = Number(v.attempt) || 0;
  if (verified !== current) return { ran: false, note: `stale: verified attempt ${verified}, current attempt ${current}` };
  const scope = v.scope || {};
  const total = parseChecks(t.body).length;
  const recorded = (v.checks || []).length;
  const partial = v.partial === true || recorded < total;
  const out = {
    ran: true,
    pass: !!v.pass && !partial,
    checks: (v.checks || []).map((c) => ({ n: c.n, cmd: cut(c.cmd, 200), pass: !!c.pass, exit: c.exit })),
    outOfScope: scope.outOfScope ?? null,
  };
  if (scope.outOfScope == null) out.scopeNote = cut(scope.note || 'scope not checked (no `files:` header)', 160);
  const notes = [];
  if (partial) {
    out.partial = true;
    notes.push(`partial verify (${recorded}/${total} checks): run omh verify ${t.id} without --only to check the whole ticket`);
  }
  if (v.noChecksFound) notes.push(cut(v.noChecksFound, 160));
  if (notes.length) out.note = cut(notes.join(' | '), 240);
  return out;
}

const SEV = { 高: 'high', high: 'high', 中: 'medium', medium: 'medium', 低: 'low', low: 'low' };
const SEV_LINE = /^\s*(?:[-*+]\s*)?(?:\*\*)?(高|中|低|high|medium|low)(?:\*\*)?\s*(?:[｜|:：]|$)/i;

// Reviewer findings are "severity｜file:line｜problem｜evidence｜fix" (or English), one per line.
// The manager appends its own verdict at the end; that verdict is not a finding, so counting
// stops at the "经理核实" / "Manager check" heading.
function severityCounts(text) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (isManagerHeading(line)) break;
    const m = line.match(SEV_LINE);
    if (m) counts[SEV[m[1].toLowerCase()]]++;
  }
  return counts;
}

const MANAGER_MARKER = /(经理核实|Manager check)/i;

function isManagerHeading(line) {
  return /^#{1,6}\s/.test(line) && MANAGER_MARKER.test(line);
}

// Only a Markdown heading counts: prose that merely mentions the phrase is not a verdict.
function managerChecked(text) {
  return text.split(/\r?\n/).some(isManagerHeading);
}

function reviewsInfo(root, t) {
  const dir = paths(root).receipts;
  const current = Number(t.fm.attempt) || 0;
  const list = [];
  let stale = 0;
  let failed = 0;
  // Rounds are numbered by their status file, the same rule `nextReviewRound` uses. A round
  // that failed exits without writing a report, so it leaves a json and no md: skip it but
  // keep walking, or one bad round would hide every report that came after it.
  for (let n = 1; n <= 50; n++) {
    const statusFile = path.join(dir, `${t.id}.review-${n}.json`);
    if (!fileExists(statusFile)) break;
    const file = path.join(dir, `${t.id}.review-${n}.md`);
    if (!fileExists(file)) {
      failed++;
      continue;
    }
    // The review status file records which build attempt was reviewed. A review of an
    // earlier attempt is kept only as a count: it is not evidence for the current code.
    const status = readJson(statusFile, null);
    const reviewed = status && status.buildAttempt != null ? Number(status.buildAttempt) : null;
    if (reviewed == null || reviewed !== current) {
      stale++;
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    list.push({
      file: rel(root, file),
      firstLine: cut(text.split(/\r?\n/).find((l) => l.trim()) || '', 200),
      counts: severityCounts(text),
      managerChecked: managerChecked(text),
    });
  }
  return { list, stale, failed };
}

function nextStep(t, build, receipt, verify, reviews, staleReviews) {
  if (ACTIVE.has(build.state)) return `omh wait ${t.id}: the build is still running`;
  if (build.state === 'none') return `omh dispatch ${t.id}: nothing has run yet`;
  if (build.ok === false) return `build failed (${build.state}): read omh log ${t.id}, then omh dispatch ${t.id} --retry`;
  if (!receipt.exists) return `no receipt: the build delivered nothing; omh dispatch ${t.id} --retry or take the work over`;
  if (!verify.ran) return `not verified yet: omh verify ${t.id}`;
  if (verify.partial) return `verify is partial (${verify.checks.length} of the ticket's checks): omh verify ${t.id} to run them all`;
  if (!verify.pass) return `verify failed: the failing check and any out-of-scope file must be dealt with before review`;
  if (!reviews.length) {
    if (staleReviews > 0) return `${staleReviews} review round(s) are from an earlier attempt, not this code: omh review ${t.id}`;
    return `verify passed: get a cross-vendor review (omh review ${t.id})`;
  }
  if (reviews.some((r) => !r.managerChecked)) return `verify passed: check every review finding yourself, then append 经理核实 to the report`;
  return `evidence complete: omh accept ${t.id}`;
}

// ---------------------------------------------------------------- size budget

const size = (o) => JSON.stringify(o).length;

// Trim in order of least loss: long lists first, then the bulk fields, then everything
// that is not "what happened" and "what to do next". Guaranteed to end under MAX_CHARS.
// Every step that actually drops something sets truncated, so a short list never reads as
// a complete one.
function fit(out) {
  const trim = (obj, key, n) => {
    const list = obj[key] || [];
    if (list.length <= n) return;
    obj[key] = list.slice(0, n);
    out.truncated = true;
  };
  const steps = [
    () => trim(out.receipt, 'claims', 8),
    () => trim(out, 'changedFiles', 40),
    () => trim(out, 'reviews', 5),
    () => trim(out.verify, 'checks', 12),
    () => trim(out.receipt, 'claims', 3),
    () => trim(out, 'reviews', 2),
    () => {
      const checks = out.verify.checks || [];
      const kept = checks.filter((c) => !c.pass).slice(0, 5);
      if (kept.length === checks.length) return;
      out.verify.checks = kept;
      out.verify.omittedChecks = checks.length - kept.length;
      out.truncated = true;
    },
    () => {
      const had = (out.reviews || []).length > 0 || (out.receipt.claims || []).length > 0;
      out.reviews = [];
      out.receipt.claims = [];
      trim(out, 'changedFiles', 20);
      if (had) out.truncated = true;
    },
    () => trim(out.verify, 'outOfScope', 10),
  ];
  for (const step of steps) {
    if (size(out) <= MAX_CHARS) return out;
    step();
  }
  if (size(out) <= MAX_CHARS) return out;
  return lastResort(out);
}

// Last resort: keep only what decides the next action. Every path, the id and the title are
// bounded here, so no input can push the result past MAX_CHARS.
function lastResort(out) {
  const o = {
    ticket: {
      id: cut(out.ticket.id, 60),
      title: cut(out.ticket.title, 80),
      state: out.ticket.state,
      attempt: out.ticket.attempt,
      claimed_by: out.ticket.claimed_by ? cut(out.ticket.claimed_by, 80) : null,
    },
    build: { state: out.build.state, ok: out.build.ok },
    receipt: { exists: out.receipt.exists, path: cut(out.receipt.path, 200) },
    verify: {
      ran: out.verify.ran,
      pass: out.verify.pass,
      outOfScope: (out.verify.outOfScope || []).slice(0, 5).map((p) => cut(p, 200)),
    },
    changedFiles: (out.changedFiles || []).slice(0, 10).map((p) => cut(p, 200)),
    // The per-round counts and the manager's verdict are what decide the next step; the
    // first line of the report is the first thing to go.
    reviews: (out.reviews || []).slice(0, 5).map((r) => ({ counts: r.counts, managerChecked: r.managerChecked })),
    next: cut(out.next, 160),
    truncated: true,
  };
  if (out.verify.note) o.verify.note = cut(out.verify.note, 160);
  if (out.staleReviews) o.staleReviews = out.staleReviews;
  if (out.failedReviews) o.failedReviews = out.failedReviews;
  if (size(o) > MAX_CHARS) {
    o.verify.outOfScope = [];
    o.changedFiles = [];
    o.reviews = [];
  }
  if (size(o) > MAX_CHARS) {
    o.next = cut(o.next, 60);
    o.ticket.title = cut(o.ticket.title, 40);
    o.receipt.path = cut(o.receipt.path, 100);
  }
  return o;
}

// ---------------------------------------------------------------- packet

export function packet(root, ref) {
  const t = findTicket(root, ref);
  const scope = changeScope(root, t);
  const build = buildInfo(root, t);
  const receipt = receiptInfo(root, t);
  const verify = verifyInfo(root, t);
  const { list: reviews, stale: staleReviews, failed: failedReviews } = reviewsInfo(root, t);
  const changedFiles = scope.changed || [];
  const out = {
    ticket: {
      id: t.id,
      title: cut(t.title, 120),
      state: t.state,
      attempt: Number(t.fm.attempt) || 0,
      claimed_by: t.fm.claimed_by ? cut(t.fm.claimed_by, 120) : null,
    },
    build,
    receipt,
    verify,
    changedFiles,
    reviews,
    staleReviews,
    next: nextStep(t, build, receipt, verify, reviews, staleReviews),
  };
  if (!scope.changed) out.changedNote = 'workdir is not a git repo: no change list';
  if (failedReviews) out.failedReviews = failedReviews;
  return fit(out);
}
