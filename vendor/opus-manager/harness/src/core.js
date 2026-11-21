// Core operations. Every function returns plain data (never prints), so the CLI and the
// MCP server share them and stdout stays clean for the MCP protocol.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, getWorker, paths, sampleConfig } from './config.js';
import { getAdapter, listAdapters, buildArgs } from './adapters.js';
import { which, resolveInvocation, runSync, runShellSync, spawnDetachedNode, killTree, checkShell } from './spawn.js';
import {
  findTicket, moveTicket, updateTicketFm, readyTickets, listTickets, depsOf, parseChecks,
  allowedFiles, createTicket, STATES,
} from './tickets.js';
import { jobFiles, readStatus, effectiveState, allStatuses, runningJobs, logEvent, readEvents, nextReviewRound, spentUsd } from './jobs.js';
import { pickBuilder, pickReviewers, workerProblems } from './router.js';
import { triage as triageRules } from './triage.js';
import { quotaReport, tierOf } from './quota.js';
import { buildPrompt, reviewPrompt, retryNote, scopeText } from './prompts.js';
import { indexFiles, renderIndex } from './codeindex.js';
import { recommendChecks } from './checks.js';
import { git, isGitRepo, headSha, changedFiles, changedSince, unchangedSince, takeBaseline, repoTop, diffText, addWorktree, commitAll } from './git.js';
import {
  ensureDir, readJson, writeJsonAtomic, writeFileAtomic, nowIso, localStamp, fileExists, tailText,
  readTail, humanDuration, matchesAny, appendLine, sleepSync, isPidAlive, OmhError,
} from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_DIR = path.resolve(HERE, '..');
const SUPERVISOR = path.join(HERE, 'supervisor.js');
const TEMPLATES = path.join(HARNESS_DIR, 'templates');
export const VERSION = readJson(path.join(HARNESS_DIR, 'package.json'), {}).version || '0.0.0';

const ACTIVE = new Set(['starting', 'running']);
const BOOKKEEPING = [/^_tickets\//, /^_receipts\//, /^\.omh\//];

function templatePath(kind, lang) {
  const f = path.join(TEMPLATES, `${kind}.${lang}.md`);
  return fs.existsSync(f) ? f : path.join(TEMPLATES, `${kind}.zh.md`);
}

// ------------------------------------------------------------------ versions (cached)

function toolVersion(root, adapter) {
  const bin = which(adapter.bin);
  if (!bin) return null;
  const cacheFile = paths(root).cache;
  const cache = readJson(cacheFile, {});
  let mtime = 0;
  try {
    mtime = fs.statSync(bin).mtimeMs;
  } catch {}
  const key = `${bin}|${mtime}`;
  if (cache.versions && key in cache.versions) return cache.versions[key] || null;
  if (adapter.versionCommand === null) return null;
  const r = runSync(adapter.bin, [...(adapter.binArgs || []), ...(adapter.versionCommand || ['--version'])], { timeoutMs: 10000 });
  const v = r.status === 0 ? ((r.stdout || r.stderr).trim().split(/\r?\n/)[0] || '').slice(0, 80) : '';
  try {
    cache.versions = { ...(cache.versions || {}), [key]: v };
    writeJsonAtomic(cacheFile, cache);
  } catch {}
  return v || null;
}

// ------------------------------------------------------------------ init / detect / probe

export function init(root, { mcp = false } = {}) {
  const p = paths(root);
  const created = [];
  for (const s of STATES) {
    if (!fs.existsSync(p.state(s))) {
      ensureDir(p.state(s));
      created.push(path.relative(root, p.state(s)));
    }
  }
  for (const d of [p.receipts, p.jobs]) if (!fs.existsSync(d)) {
    ensureDir(d);
    created.push(path.relative(root, d));
  }
  const gi = path.join(p.omh, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'jobs/\nworktrees/\ncache.json\n');
  // Receipts, review reports, progress.md and events.jsonl belong in the repo; raw logs,
  // status files and diff snapshots are local working files.
  const rgi = path.join(p.receipts, '.gitignore');
  if (!fs.existsSync(rgi)) fs.writeFileSync(rgi, '*.log\n*.build.json\n*.review-*.json\n*.verify.json\n*.diff\n');
  if (!fs.existsSync(p.config)) {
    const detected = detect(root).tools.filter((t) => t.found).map((t) => t.adapter);
    writeJsonAtomic(p.config, sampleConfig(detected));
    created.push(path.relative(root, p.config));
  }
  let mcpFile = null;
  if (mcp) {
    mcpFile = path.join(root, '.mcp.json');
    const cur = readJson(mcpFile, {});
    cur.mcpServers = cur.mcpServers || {};
    cur.mcpServers.omh = { command: 'node', args: [path.join(HARNESS_DIR, 'bin', 'omh.js'), 'mcp'], env: { OMH_ROOT: root } };
    writeJsonAtomic(mcpFile, cur);
    created.push('.mcp.json');
  }
  return { root, created, config: p.config, mcp: mcpFile };
}

export function detect(root) {
  const cfg = loadConfig(root);
  const tools = listAdapters(cfg).map((name) => {
    const a = getAdapter(cfg, name);
    const bin = which(a.bin);
    return {
      adapter: name,
      bin: a.bin,
      found: !!bin,
      path: bin,
      version: bin ? toolVersion(root, a) : null,
      canBuild: !!a.build,
      canReview: !!a.review,
      via: bin ? resolveInvocation(a.bin, []).via : null,
    };
  });
  return { platform: process.platform, node: process.version, checkShell: checkShell(process.env, cfg.shell), tools };
}

export function probe(root, name, { full = false } = {}) {
  const cfg = loadConfig(root);
  const a = getAdapter(cfg, name);
  if (!which(a.bin)) return { adapter: name, found: false, ok: false, problem: `${a.bin} not on PATH` };
  const r = runSync(a.bin, [...(a.binArgs || []), ...(a.helpCommand || ['--help'])], { timeoutMs: 30000 });
  const help = `${r.stdout}\n${r.stderr}`;
  const missing = (a.helpMustContain || []).filter((flag) => !help.includes(flag));
  return {
    adapter: name,
    found: true,
    version: toolVersion(root, a),
    ok: missing.length === 0,
    missingFlags: missing,
    buildTemplate: a.build,
    reviewTemplate: a.review,
    note: missing.length
      ? 'Preset flags not found in --help. Read the help, then override this adapter under "adapters" in .omh/config.json.'
      : 'Flags present in --help. Still run `omh trial <worker>` before trusting it.',
    help: full ? help : tailText(help, 60, 6000),
  };
}

// ------------------------------------------------------------------ tickets

export function newTicket(root, opts) {
  const cfg = loadConfig(root);
  const lang = opts.lang || cfg.lang;
  const templateText = fs.readFileSync(templatePath('ticket', lang), 'utf8');
  const t = createTicket(root, { ...opts, lang, templateText });
  return { id: t.id, path: t.path, note: 'Fill in goal / boundaries / acceptance commands, then `omh dispatch ' + t.id + '`.' };
}

export function next(root) {
  const cfg = loadConfig(root);
  return readyTickets(root).map((t) => {
    let suggested = null;
    let why = null;
    if (t.ready) {
      try {
        suggested = pickBuilder(cfg, root, t).worker.id;
      } catch (e) {
        why = e.message;
      }
    }
    return { id: t.id, title: t.title, kind: t.fm.kind || 'default', ready: t.ready, waitingOn: t.waitingOn, suggestedWorker: suggested, problem: why };
  });
}

function resolveWorkdir(root, t) {
  if (t.fm.worktree_path) return path.resolve(root, t.fm.worktree_path);
  return path.resolve(root, t.fm.workdir || '.');
}

// A symbol outline of the ticket's `files:` that already exist, written to
// _receipts/<T>.index.md so the worker reads a map instead of whole files. `files:` is
// relative to the worktree root (or the repo root), the same base changeScope uses —
// indexing the workdir instead would point at the wrong file when the ticket has a
// `workdir:` header. Nothing to index → no file, no prompt line. The index is optional:
// its failure must never strand a ticket that has already been claimed.
function writeScopeIndex(cfg, root, t, baseDir = t.fm.worktree_path ? path.resolve(root, t.fm.worktree_path) : root) {
  if (cfg.codeIndex === false) return null;
  const patterns = allowedFiles(t);
  if (!patterns || !patterns.length) return null;
  try {
    const entries = indexFiles(baseDir, patterns);
    if (!entries.length) return null;
    const file = path.join(paths(root).receipts, `${t.id}.index.md`);
    writeFileAtomic(file, renderIndex(entries));
    return file;
  } catch (e) {
    logEvent(root, 'index-error', { ticket: t.id, error: e.message });
    return null;
  }
}

// ------------------------------------------------------------------ dispatch

function launch(root, cfg, { ticket, phase, attempt, worker, adapter, args, workdir, files, timeoutMin, extra = {} }) {
  const env = { ...process.env, ...(worker.env || {}) };
  const inv = resolveInvocation(adapter.bin, args, env);
  if (!inv) throw new OmhError(`${adapter.bin} not found on PATH`, 'E_NOT_FOUND');
  const version = toolVersion(root, adapter);
  const statusBase = {
    ticket: ticket.id,
    ticketName: ticket.name,
    phase,
    attempt,
    worker: worker.id,
    adapter: adapter.name,
    model: worker.model || null,
    provider: worker.provider || null,
    vendor: worker.vendor || null,
    engine: `${adapter.name}${version ? ` ${version}` : ''} / ${worker.model || 'default model'}`,
    workdir,
    ...extra,
  };
  const spec = {
    cmd: { file: inv.file, args: inv.args, windowsVerbatimArguments: inv.windowsVerbatimArguments },
    display: [adapter.bin, ...args.map((a) => (a.length > 80 ? a.slice(0, 77) + '...' : a))].join(' '),
    cwd: workdir,
    env: worker.env || {},
    stdinText: adapter.promptVia === 'stdin' ? extra.prompt : null,
    logFile: files.log,
    statusFile: files.status,
    eventsFile: paths(root).events,
    receiptFile: phase === 'build' ? files.receipt : null,
    reportFile: files.report,
    lastMessageFile: files.lastMessage,
    finalAnswer: adapter.finalAnswer,
    usageParser: adapter.usage,
    timeoutMs: timeoutMin * 60 * 1000,
    idleWarnMs: (cfg.timeouts.idleWarnMin || 10) * 60 * 1000,
    tickMs: Number(process.env.OMH_TICK_MS) || 5000,
    statusBase,
  };
  delete spec.statusBase.prompt;
  ensureDir(path.dirname(files.spec));
  ensureDir(path.dirname(files.log));
  try { fs.unlinkSync(files.lastMessage); } catch {}
  try { fs.unlinkSync(`${files.spec}.kill`); } catch {}
  writeJsonAtomic(files.spec, spec);
  const pid = spawnDetachedNode(SUPERVISOR, [files.spec], { cwd: workdir, env, launcher: cfg.launcher });
  writeJsonAtomic(files.status, { ...statusBase, state: 'starting', supervisorPid: pid, startedAt: nowIso(), lastActivityAt: nowIso(), logFile: files.log });
  return { pid, engine: statusBase.engine, via: inv.via };
}

// ---- master switch --------------------------------------------------------------------
// enabled: true  → "on": the manager connects automatically at the start of every task
// enabled: false → "off": nothing is dispatched (explicit --force excepted, recorded)
// unset          → "manual": dispatch only when explicitly asked (the v0.3 behaviour)
export function switchStatus(root) {
  const cfg = loadConfig(root);
  const mode = cfg.enabled === true ? 'on' : cfg.enabled === false ? 'off' : 'manual';
  const ws = Object.values(cfg.workers).map((w) => ({
    id: w.id,
    tier: tierOf(w),
    roles: w.roles,
    problems: [...(w.roles.includes('build') ? workerProblems(cfg, w, root, 'build') : []), ...(w.roles.includes('review') ? workerProblems(cfg, w, root, 'review') : [])],
  }));
  const readyBuilders = ws.filter((w) => w.roles.includes('build') && !w.problems.length).map((w) => w.id);
  const readyReviewers = ws.filter((w) => w.roles.includes('review') && !w.problems.length).map((w) => w.id);
  return {
    mode,
    ready: readyBuilders.length > 0 && readyReviewers.length > 0,
    readyBuilders,
    readyReviewers,
    workers: ws,
    hint: mode === 'on' ? 'Use the ticket workflow for suitable tasks: triage first; keep trivial/high-risk work.' : mode === 'off' ? 'Collaboration is off: work normally, dispatch nothing.' : 'Manual: dispatch only when the user asks for it.',
  };
}

export function switchSet(root, on) {
  const p = paths(root);
  if (!fs.existsSync(p.config)) throw new OmhError('project not initialised: run omh init first', 'E_INIT');
  const raw = readJson(p.config, {});
  raw.enabled = !!on;
  writeJsonAtomic(p.config, raw);
  logEvent(root, 'switch', { enabled: !!on });
  return switchStatus(root);
}

export function triage(root, ref) {
  const cfg = loadConfig(root);
  return triageRules(cfg, findTicket(root, ref));
}

export function quota(root) {
  return quotaReport(loadConfig(root), root);
}

export function dispatch(root, ref, { worker: override, retry = false, force = false, reason } = {}) {
  const cfg = loadConfig(root);
  let t = findTicket(root, ref);
  if (cfg.enabled === false && !force) throw new OmhError('collaboration is switched off for this project (omh switch on, or --force with a reason)', 'E_OFF');
  // dispatch gate: only scoped, decidable, worthwhile tickets go out (retries were already admitted)
  if (!retry) {
    const tri = triageRules(cfg, t);
    if (tri.decision !== 'dispatch') {
      if (!force) throw new OmhError(`triage says "${tri.decision}" for ${t.id}: ${tri.reasons.join(' | ')}`, 'E_TRIAGE', { triage: tri });
      if (!reason) throw new OmhError('--force over a triage refusal needs --reason', 'E_USAGE');
      logEvent(root, 'triage-override', { ticket: t.id, decision: tri.decision, reasons: tri.reasons, reason });
    }
  }
  const prevStatus = readStatus(jobFiles(root, t, 'build').status);
  if (prevStatus && ACTIVE.has(effectiveState(prevStatus))) throw new OmhError(`${t.id} is already running (worker ${prevStatus.worker})`, 'E_RUNNING');

  if (t.state === 'doing' || t.state === 'blocked') {
    if (!retry) throw new OmhError(`${t.id} is in ${t.state}/. Use --retry to run it again.`, 'E_STATE');
  } else if (t.state !== 'open') {
    throw new OmhError(`${t.id} is in ${t.state}/, only open/ tickets can be dispatched`, 'E_STATE');
  }
  const attempt = (Number(t.fm.attempt) || 0) + 1;
  if (attempt > cfg.maxAttempts && !force) {
    if (t.state !== 'blocked') {
      t = moveTicket(root, t, 'blocked');
      updateTicketFm(t, { blocked_reason: `failed ${attempt - 1} times` });
    }
    throw new OmhError(`${t.id} already failed ${attempt - 1} times; moved to blocked/. Decide what to change, or pass --force.`, 'E_ATTEMPTS');
  }
  if (t.state === 'open') {
    const done = new Set(listTickets(root, ['done', 'dropped']).map((x) => x.id.toLowerCase()));
    const waiting = depsOf(t).filter((d) => !done.has(d.toLowerCase()));
    if (waiting.length && !force) throw new OmhError(`${t.id} waits on ${waiting.join(', ')}`, 'E_DEPS');
  }
  if (cfg.budget?.totalUsd != null) {
    const spent = spentUsd(root);
    if (spent >= cfg.budget.totalUsd) throw new OmhError(`total budget $${cfg.budget.totalUsd} used ($${spent.toFixed(2)})`, 'E_BUDGET');
  }

  const ticketBudget = Number(t.fm.budget_usd) || cfg.budget?.perTicketUsd;
  if (ticketBudget && !force) {
    const spentHere = spentUsd(root, (e) => e.ticket === t.id);
    if (spentHere >= ticketBudget) throw new OmhError(`${t.id} already spent $${spentHere.toFixed(2)} of its $${ticketBudget} budget; decide before spending more (--force)`, 'E_BUDGET');
  }

  const { worker } = pickBuilder(cfg, root, t, { override, previousWorker: retry && !override ? prevStatus?.worker : null });
  const adapter = getAdapter(cfg, worker.adapter);

  // claim: the rename is the lock
  if (t.state !== 'doing') t = moveTicket(root, t, 'doing');

  // workdir / isolation
  let workdir = resolveWorkdir(root, t);
  // The base `files:` is written against: the worktree root when there is one, else the
  // repo root. Same rule as changeScope, so the index and the scope check agree.
  let indexBase = t.fm.worktree_path ? path.resolve(root, t.fm.worktree_path) : root;
  const patch = {};
  if (t.fm.worktree === true && !t.fm.worktree_path) {
    if (!isGitRepo(root)) throw new OmhError('worktree: true needs a git repo', 'E_GIT');
    const dir = path.join(paths(root).worktrees, t.id);
    patch.base_sha = headSha(root);
    addWorktree(root, dir, `omh/${t.id}`, patch.base_sha);
    patch.worktree_path = path.relative(root, dir).replace(/\\/g, '/');
    workdir = t.fm.workdir ? path.join(dir, t.fm.workdir) : dir;
    indexBase = dir; // created just now: t.fm.worktree_path is not written back yet
  } else if (!t.fm.base_sha && fs.existsSync(workdir) && isGitRepo(workdir)) {
    patch.base_sha = headSha(workdir);
    // Only ever the first one: taken again on a retry, it would excuse what attempt 1 left behind.
    const baselineFile = jobFiles(root, t, 'build').baseline;
    if (!fs.existsSync(baselineFile)) writeJsonAtomic(baselineFile, takeBaseline(workdir, patch.base_sha));
  }
  if (!fs.existsSync(workdir)) {
    t = moveTicket(root, t, 'blocked');
    updateTicketFm(t, { blocked_reason: `workdir not found: ${workdir}` });
    throw new OmhError(`workdir ${workdir} does not exist; ticket moved to blocked/`, 'E_WORKDIR');
  }

  const files = jobFiles(root, t, 'build', attempt);
  const lang = cfg.lang;
  const version = toolVersion(root, adapter);
  const engine = `${adapter.name}${version ? ` ${version}` : ''} / ${worker.model || 'default model'}`;
  const prevLog = prevStatus?.logFile;
  const codeIndex = writeScopeIndex(cfg, root, t, indexBase);
  const prompt = buildPrompt(lang, {
    ticket: t.path,
    workdir,
    template: templatePath('receipt', lang),
    receipt: files.receipt,
    engine,
    retryNote: attempt > 1 && prevLog ? retryNote(lang, attempt, prevLog) : '',
    codeIndex,
  });
  const args = buildArgs(adapter, 'build', { prompt, model: worker.model, provider: worker.provider, effort: worker.effort, tools: worker.tools, reviewTools: worker.reviewTools, lastMessageFile: files.lastMessage, cwd: workdir });
  if (attempt > 1) {
    try { fs.unlinkSync(files.receipt); } catch {}
  }
  // signature is written by the harness, not self-reported by the worker
  updateTicketFm(t, { ...patch, attempt, claimed_by: `${worker.id} (${engine})`, claimed_at: nowIso() });

  const timeoutMin = Number(t.fm.timeout_min) || cfg.timeouts.buildMin;
  const run = launch(root, cfg, { ticket: t, phase: 'build', attempt, worker, adapter, args, workdir, files, timeoutMin, extra: { prompt } });
  logEvent(root, 'dispatch', { ticket: t.id, worker: worker.id, attempt, engine: run.engine });
  return {
    ticket: t.id,
    worker: worker.id,
    engine: run.engine,
    attempt,
    workdir,
    log: files.log,
    receipt: files.receipt,
    timeoutMin,
    supervisorPid: run.pid,
    next: `omh wait ${t.id}   (run it as a background command; it returns when the worker exits)`,
  };
}

// ------------------------------------------------------------------ review

function receiptFileList(receiptPath) {
  try {
    const text = fs.readFileSync(receiptPath, 'utf8');
    const sec = text.split(/^##\s*2\b.*$/m)[1]?.split(/^##\s/m)[0] || '';
    return [...sec.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

export function review(root, ref, { reviewer, count = 1 } = {}) {
  const cfg = loadConfig(root);
  const t = findTicket(root, ref);
  if (!['doing', 'done'].includes(t.state)) throw new OmhError(`${t.id} is in ${t.state}/; review needs a built ticket (doing/ or done/)`, 'E_STATE');
  const build = readStatus(jobFiles(root, t, 'build').status);
  if (build && ACTIVE.has(effectiveState(build))) throw new OmhError(`${t.id} is still being built`, 'E_RUNNING');
  const { reviewers } = pickReviewers(cfg, root, { builderVendor: build?.vendor, override: reviewer, count });
  const workdir = resolveWorkdir(root, t);
  const lang = cfg.lang;
  const files0 = jobFiles(root, t, 'review-0');
  let scope;
  if (isGitRepo(workdir)) {
    const inherited = unchangedSince(workdir, readJson(files0.baseline, {}));
    writeFileAtomic(files0.diff, diffText(workdir, t.fm.base_sha, inherited) || '(empty diff)\n');
    scope = scopeText(lang, 'diff', files0.diff);
  } else {
    const list = receiptFileList(files0.receipt);
    scope = list.length ? scopeText(lang, 'files', list.join(', ')) : scopeText(lang, 'unknown');
  }
  const out = [];
  for (const w of reviewers) {
    const adapter = getAdapter(cfg, w.adapter);
    const round = nextReviewRound(root, t);
    const phase = `review-${round}`;
    const files = jobFiles(root, t, phase);
    const version = toolVersion(root, adapter);
    const engine = `${adapter.name}${version ? ` ${version}` : ''} / ${w.model || 'default model'}`;
    const prompt = reviewPrompt(lang, {
      ticket: t.path,
      receipt: files.receipt,
      scope,
      builder: build?.engine || 'unknown',
      engine,
      time: localStamp(),
    });
    const args = buildArgs(adapter, 'review', { prompt, model: w.model, provider: w.provider, effort: w.effort, tools: w.tools, reviewTools: w.reviewTools, lastMessageFile: files.lastMessage, cwd: workdir });
    const run = launch(root, cfg, { ticket: t, phase, attempt: 1, worker: w, adapter, args, workdir, files, timeoutMin: cfg.timeouts.reviewMin, extra: { prompt, builderVendor: build?.vendor || null, buildAttempt: Number(t.fm.attempt) || 0 } });
    logEvent(root, 'review', { ticket: t.id, worker: w.id, round });
    out.push({ ticket: t.id, phase, worker: w.id, engine: run.engine, report: files.report, log: files.log });
  }
  return { reviews: out, next: `omh wait ${t.id} --phase review` };
}

// ------------------------------------------------------------------ status / wait

function summarize(st, { withTail = false } = {}) {
  const eff = effectiveState(st);
  const now = Date.now();
  const s = {
    ticket: st.ticket,
    phase: st.phase,
    worker: st.worker,
    engine: st.engine,
    state: eff,
    ok: st.ok ?? null,
    exitCode: st.exitCode ?? null,
    elapsed: humanDuration((st.endedAt ? Date.parse(st.endedAt) : now) - Date.parse(st.startedAt)),
    quietFor: ACTIVE.has(eff) ? humanDuration(now - Date.parse(st.lastActivityAt || st.startedAt)) : undefined,
    idle: ACTIVE.has(eff) ? !!st.idle : undefined,
    receipt: st.phase === 'build' && !ACTIVE.has(eff) ? (st.receiptExists ? 'written' : 'MISSING') : undefined,
    report: st.phase !== 'build' && !ACTIVE.has(eff) ? st.reportExists ? st.logFile.replace(/\.log$/, '.md') : 'MISSING' : undefined,
    costUsd: st.usage?.costUsd != null ? Number(st.usage.costUsd.toFixed(4)) : undefined,
    credits: st.usage?.credits ?? undefined,
    tokens: st.usage ? (st.usage.totalTokens ?? ((st.usage.inputTokens || 0) + (st.usage.outputTokens || 0) || undefined)) : undefined,
    error: !ACTIVE.has(eff) && !st.ok ? st.error : undefined,
  };
  if (withTail && !ACTIVE.has(eff) && !st.ok) s.logTail = tailText(readTail(st.logFile, 16 * 1024), 15, 2000);
  if (st.heartbeatAt && (ACTIVE.has(eff) || eff === 'lost')) {
    s.supervisorLastSeen = st.heartbeatAt;
    s.supervisorSilentFor = humanDuration(now - Date.parse(st.heartbeatAt));
  }
  if (eff === 'lost') {
    s.note = st.heartbeatAt
      ? `supervisor last seen ${st.heartbeatAt} (${s.supervisorSilentFor} ago): the machine slept/rebooted, or the host that started it (terminal / agent session) was closed and took it down. Work in the workdir is kept. Check the log, then \`omh dispatch --retry\`.`
      : 'supervisor process is gone (machine slept/rebooted, or its host was closed). Check the log, then `omh dispatch --retry`.';
  }
  if (st.state === 'timeout') s.note = 'hit the hard timeout and was killed';
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
}

export function status(root) {
  const cfg = loadConfig(root);
  const tickets = listTickets(root);
  const counts = Object.fromEntries(STATES.map((s) => [s, tickets.filter((t) => t.state === s).length]));
  const sts = allStatuses(root);
  const running = sts.filter((s) => ACTIVE.has(s.effective)).map((s) => summarize(s));
  const since = Date.now() - 12 * 3600 * 1000;
  const recent = sts
    .filter((s) => !ACTIVE.has(s.effective) && Date.parse(s.endedAt || s.startedAt) > since)
    .sort((a, b) => Date.parse(b.endedAt || 0) - Date.parse(a.endedAt || 0))
    .slice(0, 10)
    .map((s) => summarize(s));
  const blocked = tickets.filter((t) => t.state === 'blocked').map((t) => ({ id: t.id, reason: t.fm.blocked_reason || '(no reason written)' }));
  const ready = readyTickets(root).filter((t) => t.ready).map((t) => t.id);
  const spent = spentUsd(root);
  return {
    counts,
    running,
    recent,
    ready,
    blocked,
    spentUsd: Number(spent.toFixed(4)),
    budgetUsd: cfg.budget?.totalUsd ?? null,
    maxParallel: cfg.maxParallel,
  };
}

function targetStatuses(root, refs, phase) {
  if (!refs.length) return runningJobs(root).map((s) => s.file);
  const out = [];
  const all = allStatuses(root);
  for (const ref of refs) {
    const t = findTicket(root, ref);
    let mine = all.filter((s) => s.ticket === t.id);
    if (phase === 'build') mine = mine.filter((s) => s.phase === 'build');
    else if (phase === 'review') mine = mine.filter((s) => s.phase.startsWith('review-'));
    else if (phase) mine = mine.filter((s) => s.phase === phase);
    if (!mine.length) throw new OmhError(`no ${phase || ''} job found for ${t.id}`.replace('  ', ' '), 'E_NO_JOB');
    const active = mine.filter((s) => ACTIVE.has(s.effective));
    if (active.length) out.push(...active.map((s) => s.file));
    else {
      // nothing running: report the most recent build and/or review
      const latest = [...mine].sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt));
      const seen = new Set();
      for (const s of latest) {
        const k = s.phase === 'build' ? 'build' : 'review';
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(s.file);
      }
    }
  }
  return [...new Set(out)];
}

export async function wait(root, refs = [], { timeoutSec = 3600, phase, any = false, pollMs = 3000 } = {}) {
  const files = targetStatuses(root, refs, phase);
  if (!files.length) return { done: true, timedOut: false, jobs: [], note: 'nothing is running' };
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const sts = files.map((f) => readStatus(f)).filter(Boolean);
    const ended = sts.filter((s) => !ACTIVE.has(effectiveState(s)));
    const finished = any ? ended.length > 0 : ended.length === sts.length;
    if (finished || Date.now() >= deadline) {
      return {
        done: finished,
        timedOut: !finished,
        jobs: sts.map((s) => summarize(s, { withTail: true })),
        hint: finished ? undefined : 'Still running. If quietFor keeps growing AND the log is not changing, inspect with `omh log`; otherwise wait again.',
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ------------------------------------------------------------------ verify (manager-side evidence)

// What actually changed in the workdir, relative to the worktree base, minus harness
// bookkeeping; and which of those files the ticket's `files:` header does not allow.
// verify reports this; `omh packet` reuses it instead of keeping a second copy of the rule.
export function changeScope(root, t, workdir = resolveWorkdir(root, t)) {
  if (!isGitRepo(workdir)) return { checked: false };
  const top = repoTop(workdir);
  const base = t.fm.worktree_path ? path.resolve(root, t.fm.worktree_path) : root;
  const fromBase = (f) => path.relative(base, path.join(top, f)).replace(/\\/g, '/');
  const baseline = readJson(jobFiles(root, t, 'build').baseline, {});
  const changed = changedSince(workdir, t.fm.base_sha, baseline)
    .map(fromBase)
    .filter((f) => !BOOKKEEPING.some((re) => re.test(f)));
  const preexisting = unchangedSince(workdir, baseline).map(fromBase);
  const allowed = allowedFiles(t);
  return {
    checked: !!allowed,
    changed,
    // Uncommitted before the worker started and still identical, so not counted above.
    ...(preexisting.length ? { preexisting } : {}),
    outOfScope: allowed ? changed.filter((f) => !matchesAny(f, allowed)) : undefined,
    note: allowed ? undefined : 'ticket has no `files:` header, so scope was not enforced; read the change list yourself',
  };
}

// Advice for the manager: match the files verify would compare (the same changed-file
// rule) against config.acceptanceProfiles and print the commands to run. Never executes.
export function checks(root, ref) {
  const cfg = loadConfig(root);
  const t = findTicket(root, ref);
  const scope = changeScope(root, t);
  const fromGit = Array.isArray(scope.changed);
  // No git repo → changeScope cannot see the change, so fall back to the ticket's own
  // `files:` header (what the author meant to touch) instead of inventing a list.
  const changedFiles = fromGit ? scope.changed : allowedFiles(t) || [];
  return {
    ticket: t.id,
    source: fromGit ? 'git' : 'ticket',
    // No git → the `files:` globs stand in for real paths, so a profile glob can miss a
    // ticket glob that would have matched the actual change. Say it is approximate.
    ...(fromGit ? {} : { note: '非 git 项目：这里是拿工单 files 的模式做近似匹配，改动与模式不一致时会漏判，建议用工单自己的验收命令核对' }),
    changedFiles,
    ...recommendChecks(cfg, changedFiles, t),
  };
}

export function verify(root, ref, { only, timeoutMin } = {}) {
  const cfg = loadConfig(root);
  const t = findTicket(root, ref);
  const workdir = resolveWorkdir(root, t);
  const checks = parseChecks(t.body);
  const pick = only ? new Set(String(only).split(',').map((n) => Number(n.trim()))) : null;
  const logPath = path.join(paths(root).receipts, `${t.id}.verify.log`);
  const logParts = [`# omh verify ${t.id} @ ${nowIso()} in ${workdir}\n`];
  const results = [];
  checks.forEach((c, i) => {
    const n = i + 1;
    if (pick && !pick.has(n)) return;
    const t0 = Date.now();
    const r = runShellSync(c.cmd, { cwd: workdir, shell: cfg.shell, timeoutMs: (timeoutMin || cfg.timeouts.checkMin) * 60 * 1000 });
    const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
    logParts.push(`\n## ${n}. ${c.cmd}\n# exit=${r.status} ${r.timedOut ? 'TIMEOUT' : ''}\n${out}\n`);
    const pass = r.status === 0 && !r.timedOut;
    results.push({ n, cmd: c.cmd, expect: c.expect || undefined, exit: r.status, pass, ms: Date.now() - t0, output: tailText(out.trim(), pass ? 8 : 30, pass ? 1200 : 4000) });
  });
  writeFileAtomic(logPath, logParts.join(''));

  // scope: which files changed vs which the ticket allows
  const scope = changeScope(root, t, workdir);
  const receipt = jobFiles(root, t, 'build').receipt;
  const pass = results.length > 0 && results.every((r) => r.pass) && !(scope.outOfScope?.length);
  const out = {
    ticket: t.id,
    // Which build attempt these results belong to. `omh packet` refuses evidence from an
    // earlier attempt: after a retry the code under test is different code.
    attempt: Number(t.fm.attempt) || 0,
    // Only a selection that left checks unrun makes the result partial; --only naming every
    // check is a whole-ticket verify and must not be reported as partial.
    ...(pick && results.length < checks.length ? { partial: true } : {}),
    pass,
    checks: results,
    noChecksFound: results.length === 0 ? 'No backticked commands under "## 验收"/"## Acceptance". Add them or verify by hand.' : undefined,
    scope,
    receipt: fileExists(receipt) ? receipt : 'MISSING',
    fullLog: logPath,
  };
  // The machine-readable twin of the log: `omh packet` reads it, so the manager does not
  // have to parse log text. Written exactly as returned.
  writeJsonAtomic(path.join(paths(root).receipts, `${t.id}.verify.json`), out);
  return out;
}

// ------------------------------------------------------------------ move / accept / kill / log / cost

export function move(root, ref, to, { reason, commit = false, reset = false } = {}) {
  const t0 = findTicket(root, ref);
  for (const ph of ['build']) {
    const st = readStatus(jobFiles(root, t0, ph).status);
    if (st && ACTIVE.has(effectiveState(st)) && to !== 'doing') throw new OmhError(`${t0.id} is still running; omh kill it first`, 'E_RUNNING');
  }
  const t = moveTicket(root, t0, to);
  const patch = {};
  if (to === 'blocked') patch.blocked_reason = reason || t.fm.blocked_reason || '(no reason given)';
  if (to === 'dropped') patch.dropped_reason = reason || '(no reason given)';
  if (to === 'done') patch.done_at = nowIso();
  if (to === 'open') {
    // Keep the failure count: putting a ticket back must not bypass maxAttempts.
    // Only an explicit --reset (a manager's decision) starts it from zero again.
    if (reset) patch.attempt = 0;
    patch.blocked_reason = undefined;
  }
  updateTicketFm(t, patch);
  let sha = null;
  const build = readStatus(jobFiles(root, t, 'build').status);
  if (to === 'done' || to === 'dropped') {
    const p = paths(root);
    if (!fs.existsSync(p.progress)) appendLine(p.progress, '| 时间 / time | 工单 / ticket | 结果 / result | 工人 / worker | 花费 / cost | 用时 / took |\n|---|---|---|---|---|---|');
    const cost = spentUsd(root, (e) => e.ticket === t.id);
    appendLine(p.progress, `| ${localStamp()} | ${t.id} ${t.title} | ${to}${reason ? `: ${reason}` : ''} | ${build?.engine || '-'} | ${cost ? `$${cost.toFixed(2)}` : '-'} | ${build?.durationMs ? humanDuration(build.durationMs) : '-'} |`);
  }
  // Log before committing, so the commit includes this event and leaves the tree clean.
  logEvent(root, 'move', { ticket: t.id, to, reason, ...(to === 'open' && reset ? { reset: true } : {}) });
  let skipped;
  if (to === 'done' && commit) {
    const cwd = resolveWorkdir(root, t);
    if (isGitRepo(cwd)) {
      const r = commitTicket(root, t, cwd);
      sha = r.sha;
      skipped = r.skipped.length ? r.skipped : undefined;
    }
  }
  return { ticket: t.id, state: to, path: t.path, commit: sha, notCommitted: skipped };
}

const KILL_POLL_MS = 100;
const KILL_PID_WAIT_MS = 3000; // wait this long for the supervisor to publish the worker pid
const KILL_GRACE_MS = 3000; // then this long for the supervisor to record the exit itself

// Commit only what belongs to this ticket: changes inside its `files:` scope plus the
// ticket/receipt bookkeeping. Unrelated work in the tree stays uncommitted (and is reported).
// Without a `files:` header there is no scope to go by, so everything is committed.
// config.commitMessage, e.g. "feat({kind}): {title} ({id})" for Conventional Commits. Default "{id}: {title}".
function commitMessage(root, t) {
  const tpl = loadConfig(root).commitMessage || '{id}: {title}';
  return tpl.replace(/\{(id|title|kind)\}/g, (_, k) => (k === 'id' ? t.id : k === 'title' ? t.title : t.fm.kind || 'default'));
}

function commitTicket(root, t, cwd) {
  const allowed = allowedFiles(t);
  const top = repoTop(cwd);
  const message = commitMessage(root, t);
  if (!allowed || !top) return { sha: commitAll(cwd, message), skipped: [] };
  const base = t.fm.worktree_path ? path.resolve(root, t.fm.worktree_path) : root;
  const rel = (f) => path.relative(base, path.join(top, f)).replace(/\\/g, '/');
  const changed = changedFiles(cwd, 'HEAD');
  const inScope = changed.filter((f) => matchesAny(rel(f), allowed));
  const skipped = changed.filter((f) => !matchesAny(rel(f), allowed));
  const book = ['_tickets', '_receipts']
    .map((d) => path.relative(top, path.join(root, d)).replace(/\\/g, '/'))
    .filter((d) => d && !d.startsWith('..') && fs.existsSync(path.join(top, d)))
    // a project may keep its ticket records out of git (.gitignore); then don't try to add them
    .filter((d) => !git(top, ['check-ignore', '-q', d]).ok);
  const specs = [...inScope, ...book].map((f) => `:(top)${f}`);
  return { sha: commitAll(cwd, message, specs), skipped };
}

export function kill(root, ref, { phase = 'build' } = {}) {
  const t = findTicket(root, ref);
  const files = jobFiles(root, t, phase);
  const st = readStatus(files.status);
  if (!st || !ACTIVE.has(effectiveState(st))) return { ticket: t.id, phase, killed: false, note: 'not running' };
  fs.writeFileSync(`${files.spec}.kill`, nowIso());

  // The supervisor publishes childPid a moment after it starts. Killing the supervisor
  // before that leaves the status frozen at "running", and the job then reads as "lost" —
  // wrong twice over: the worker may never have run, and the operator asked for a kill.
  let cur = st;
  for (let waited = 0; !cur.childPid && cur.supervisorPid && isPidAlive(cur.supervisorPid) && waited < KILL_PID_WAIT_MS; waited += KILL_POLL_MS) {
    sleepSync(KILL_POLL_MS);
    cur = readStatus(files.status) || cur;
  }
  if (!cur.childPid && cur.supervisorPid && isPidAlive(cur.supervisorPid)) {
    cur = readStatus(files.status) || cur; // last look before giving up on the pid
  }
  const killed = cur.childPid ? killTree(cur.childPid, { force: true }) : false;

  // Prefer the supervisor's own bookkeeping: it also parses usage, receipt and report.
  for (let waited = 0; waited < KILL_GRACE_MS; waited += KILL_POLL_MS) {
    const now = readStatus(files.status) || cur;
    const eff = effectiveState(now);
    if (eff !== 'starting' && eff !== 'running' && eff !== 'lost') {
      const res = { ticket: t.id, phase, killed: eff === 'killed', state: eff };
      if (eff !== 'killed') res.note = 'the worker had already finished when the kill arrived';
      logEvent(root, 'kill', { ticket: t.id, phase, state: eff });
      return res;
    }
    if (eff === 'lost') break; // supervisor is gone; record the outcome here
    sleepSync(KILL_POLL_MS);
  }

  const last = readStatus(files.status) || cur;
  if (last.supervisorPid && isPidAlive(last.supervisorPid)) killTree(last.supervisorPid, { force: true });
  const endedAt = nowIso();
  const patched = {
    ...last,
    state: 'killed',
    killedAt: endedAt,
    endedAt,
    durationMs: last.startedAt ? Date.parse(endedAt) - Date.parse(last.startedAt) : null,
    ok: false,
    recordedBy: 'omh kill',
  };
  try {
    writeJsonAtomic(files.status, patched);
  } catch {}
  logEvent(root, 'kill', { ticket: t.id, phase, state: 'killed', recordedBy: 'kill' });
  return { ticket: t.id, phase, killed: true, state: 'killed', note: 'supervisor did not report the exit; recorded by omh kill' };
}

export function log(root, ref, { phase = 'build', lines = 60 } = {}) {
  const t = findTicket(root, ref);
  const st = readStatus(jobFiles(root, t, phase).status);
  if (!st) throw new OmhError(`no ${phase} job for ${t.id}`, 'E_NO_JOB');
  return { ticket: t.id, phase, state: effectiveState(st), file: st.logFile, tail: tailText(readTail(st.logFile, 256 * 1024), lines, 12000) };
}

export function cost(root) {
  const byWorker = {};
  for (const e of readEvents(root).filter((e) => e.type === 'job-end')) {
    const w = (byWorker[e.worker] ||= { jobs: 0, ok: 0, failed: 0, costUsd: 0, costReportedJobs: 0, credits: null, tokens: 0, ms: 0 });
    if (typeof e.usage?.credits === 'number') w.credits = Number(((w.credits || 0) + e.usage.credits).toFixed(4));
    w.jobs++;
    e.ok ? w.ok++ : w.failed++;
    if (typeof e.usage?.costUsd === 'number') {
      w.costUsd += e.usage.costUsd;
      w.costReportedJobs++;
    }
    w.tokens += e.usage?.totalTokens || (e.usage?.inputTokens || 0) + (e.usage?.outputTokens || 0);
    w.ms += e.durationMs || 0;
  }
  for (const w of Object.values(byWorker)) {
    // null = the tool never reported a cost (e.g. Codex on a subscription); 0 would claim it was free
    w.costUsd = w.costReportedJobs ? Number(w.costUsd.toFixed(4)) : null;
    w.time = humanDuration(w.ms);
    delete w.ms;
  }
  return { byWorker, totalUsd: Number(spentUsd(root).toFixed(4)), note: 'costUsd null = not reported by the tool (write "not reported", not $0). totalUsd sums reported costs only.' };
}

export function workers(root) {
  const cfg = loadConfig(root);
  return Object.values(cfg.workers).map((w) => ({
    id: w.id,
    adapter: w.adapter,
    model: w.model || null,
    vendor: w.vendor || null,
    roles: w.roles,
    kinds: Object.entries(cfg.routing || {}).filter(([, ids]) => ids.includes(w.id)).map(([k]) => k),
    buildProblems: w.roles.includes('build') ? workerProblems(cfg, w, root, 'build') : undefined,
    reviewProblems: w.roles.includes('review') ? workerProblems(cfg, w, root, 'review') : undefined,
    trial: w.trial || null,
  }));
}

// ------------------------------------------------------------------ trial

const TRIAL_TICKET = {
  zh: `# T1：试跑——写一个加法函数

## 目标
在作业目录新建 add.js（导出 add(a, b)）和 add.test.js（用 node:assert 断言 add(2, 3) === 5 和 add(-1, 1) === 0，全部通过时打印 ok）。

## 边界
1. 只新建 add.js 和 add.test.js。
2. 不提交代码，不挪工单。

## 验收
1. \`node add.test.js\` → 打印 ok，退出码 0

## 为什么这样验收
确认这个工人能无头运行、能按工单改文件、能写回执。
`,
  en: `# T1: Trial — write an add function

## Goal
In the workdir create add.js (exporting add(a, b)) and add.test.js (asserting with node:assert that add(2, 3) === 5 and add(-1, 1) === 0, printing ok when all pass).

## Boundaries
1. Only create add.js and add.test.js.
2. Do not commit or move the ticket.

## Acceptance
1. \`node add.test.js\` → prints ok, exit code 0

## Why these checks
Confirms this worker runs headless, edits files as told and writes a receipt.
`,
};

export async function trial(root, workerId, { timeoutSec = 900, keep = false } = {}) {
  const cfg = loadConfig(root);
  const w = getWorker(cfg, workerId);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-trial-'));
  init(dir);
  const conf = readJson(paths(dir).config, {});
  conf.lang = cfg.lang;
  conf.adapters = cfg.adapters;
  conf.workers = { [w.id]: { ...w, consent: { codeAccess: true, autoApprove: true } } };
  conf.routing = { default: [w.id] };
  writeJsonAtomic(paths(dir).config, conf);
  const tfile = path.join(paths(dir).state('open'), 'T1-trial.md');
  fs.writeFileSync(tfile, `---\nid: T1\ntitle: trial\nfiles: [add.js, add.test.js]\n---\n${TRIAL_TICKET[cfg.lang] || TRIAL_TICKET.zh}`);
  const started = Date.now();
  const d = dispatch(dir, 'T1');
  const w8 = await wait(dir, ['T1'], { timeoutSec });
  const job = w8.jobs[0] || {};
  const v = w8.done ? verify(dir, 'T1') : null;
  const ok = !!(w8.done && job.ok && v?.pass);
  const result = { ok, date: nowIso().slice(0, 10), durationMs: Date.now() - started };
  // remember the outcome in the project config (this replaces the old workers.md "trial" line)
  try {
    const pc = readJson(paths(root).config, null);
    if (pc?.workers?.[w.id]) {
      pc.workers[w.id].trial = result;
      writeJsonAtomic(paths(root).config, pc);
    }
  } catch {}
  if (!keep && ok) fs.rmSync(dir, { recursive: true, force: true });
  return { worker: w.id, engine: d.engine, ok, took: humanDuration(result.durationMs), job, verify: v, trialDir: ok && !keep ? '(removed)' : dir };
}
