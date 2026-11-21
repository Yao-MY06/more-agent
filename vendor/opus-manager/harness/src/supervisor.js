#!/usr/bin/env node
// Detached supervisor: one per running job. Started by `omh dispatch` / `omh review`
// with `node supervisor.js <spec.json>`; it outlives the manager's session.
//
// It runs the worker, streams output to the log, keeps a heartbeat in the status file,
// enforces the hard timeout (kills the whole process tree), and on exit records exit
// code, duration, usage, whether the receipt exists, and — for reviews — the report.
//
// Watchdog rule learned the hard way: silence alone never kills a worker. A long think or
// a long test is silent. Only the hard timeout kills; idleness is reported, not punished.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { readJson, writeJsonAtomic, writeFileAtomic, nowIso, readTail, appendLine, IS_WIN } from './util.js';
import { killTree } from './spawn.js';
import { parseUsage, extractFinalAnswer, extractError } from './adapters.js';

const specPath = process.argv[2];
const spec = readJson(specPath);
if (!spec) {
  process.exit(2);
}

let finished = false; // declared up front: finish() can run before the worker is spawned
const status = {
  ...spec.statusBase,
  state: 'starting',
  supervisorPid: process.pid,
  startedAt: nowIso(),
  lastActivityAt: nowIso(),
  logFile: spec.logFile,
};
status.tickMs = spec.tickMs || 5000;
// heartbeatAt is written on every save: it tells anyone (another machine, a reused PID)
// when this supervisor was last alive, so a vanished supervisor is detected with a time.
const save = () => {
  status.heartbeatAt = nowIso();
  try {
    writeJsonAtomic(spec.statusFile, status);
  } catch {}
};
const event = (type, data) => {
  try {
    appendLine(spec.eventsFile, JSON.stringify({ ts: nowIso(), type, ticket: status.ticket, phase: status.phase, worker: status.worker, ...data }));
  } catch {}
};
save();

const logFd = fs.openSync(spec.logFile, 'a');
fs.writeSync(logFd, `# omh ${status.phase} ${status.ticket} worker=${status.worker} started ${status.startedAt}\n# cwd: ${spec.cwd}\n# cmd: ${spec.display}\n\n`);

let child;
// `omh kill` may land before we get here (dispatch returns before the supervisor is up).
// A cancelled job must not start the worker at all: it could already touch files.
const cancelledEarly = fs.existsSync(`${specPath}.kill`);
if (cancelledEarly) finish({ state: 'killed', note: 'cancelled before the worker started' });
else try {
  child = spawn(spec.cmd.file, spec.cmd.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env || {}) },
    stdio: [spec.stdinText != null ? 'pipe' : 'ignore', logFd, logFd],
    detached: !IS_WIN, // own process group on POSIX so killTree can take the whole tree
    windowsHide: true,
    windowsVerbatimArguments: spec.cmd.windowsVerbatimArguments,
  });
} catch (e) {
  finish({ state: 'failed-to-start', error: String(e.message) });
}

if (child) {
  child.on('error', (e) => finish({ state: 'failed-to-start', error: String(e.message) }));
  if (spec.stdinText != null && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(spec.stdinText);
  }
  status.state = 'running';
  status.childPid = child.pid;
  save();
  event('job-start', { childPid: child.pid, model: status.model, adapter: status.adapter });

  let lastSize = 0;
  let timedOut = false;
  const tick = setInterval(() => {
    let size = 0;
    try {
      size = fs.statSync(spec.logFile).size;
    } catch {}
    const now = Date.now();
    if (size !== lastSize) {
      lastSize = size;
      status.lastActivityAt = nowIso();
    }
    const idleMs = now - Date.parse(status.lastActivityAt);
    status.idle = idleMs > spec.idleWarnMs;
    status.logBytes = size;
    if (!timedOut && now - Date.parse(status.startedAt) > spec.timeoutMs) {
      timedOut = true;
      status.timedOut = true;
      killTree(child.pid);
      setTimeout(() => killTree(child.pid, { force: true }), 5000).unref();
    }
    save();
  }, spec.tickMs || 5000);

  child.on('exit', (code, signal) => {
    clearInterval(tick);
    finish({ state: timedOut ? 'timeout' : 'exited', exitCode: code, signal: signal || null });
  });
}

function finish(patch) {
  if (finished) return;
  finished = true;
  Object.assign(status, patch);
  if (fs.existsSync(`${specPath}.kill`)) status.state = 'killed';
  status.endedAt = nowIso();
  status.durationMs = Date.parse(status.endedAt) - Date.parse(status.startedAt);
  try {
    fs.writeSync(logFd, `\n# omh ended ${status.endedAt} state=${status.state} exit=${status.exitCode ?? ''}\n`);
    fs.closeSync(logFd);
  } catch {}
  const logText = readTail(spec.logFile, 4 * 1024 * 1024);
  status.usage = parseUsage(spec.usageParser, logText);
  if (spec.receiptFile) status.receiptExists = fs.existsSync(spec.receiptFile);
  // Only a review that finished cleanly has a report; a crash log is not a review.
  if (spec.reportFile && status.state === 'exited' && status.exitCode === 0) {
    let last = null;
    try {
      last = fs.readFileSync(spec.lastMessageFile, 'utf8');
    } catch {}
    const body = extractFinalAnswer(spec.finalAnswer, stripHeader(logText), last);
    try {
      if (body && body.trim()) {
        writeFileAtomic(spec.reportFile, body.trim() + '\n');
        status.reportExists = true;
      }
    } catch {}
  }
  status.ok = status.state === 'exited' && status.exitCode === 0 && (spec.receiptFile ? status.receiptExists : true);
  // Record why it failed, so `omh wait`/`omh status` can say it in one line instead of
  // making someone read a 600-character JSON blob out of the log.
  if (!status.ok) {
    const why = extractError(stripHeader(logText));
    if (why) status.error = why;
  }
  save();
  event('job-end', { state: status.state, exitCode: status.exitCode, ok: status.ok, durationMs: status.durationMs, usage: status.usage, error: status.error });
  setTimeout(() => process.exit(0), 50);
}

function stripHeader(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^# (omh |cwd: |cmd: )/.test(l))
    .join('\n');
}
