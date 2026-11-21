#!/usr/bin/env node
// omh — opus-manager harness CLI. Claude Code (the manager) drives this; so can you.
import { findRoot } from '../src/config.js';
import * as core from '../src/core.js';
import { packet } from '../src/packet.js';
import { OmhError } from '../src/util.js';

const HELP = `omh ${core.VERSION} — opus-manager harness (Claude manages, other AI CLIs build and review)

Setup
  omh init [--mcp]                 create _tickets/ _receipts/ .omh/config.json (--mcp: also .mcp.json for Claude Code)
  omh detect                       which AI CLIs are installed (pi, claude, codex, gemini, qwen, cursor-agent, opencode, aider…)
  omh probe <adapter> [--full]     check the adapter's preset flags against the tool's real --help
  omh workers                      configured workers and why each can/can't run
  omh trial <worker>               run a tiny real ticket in a temp dir; records the result in config

Tickets
  omh new <slug> [--title T] [--kind K] [--depends T1,T2] [--files a.js,src/**] [--workdir D] [--worker W]
  omh next                         open tickets: ready or waiting on deps, with the worker routing would pick
  omh triage <T>                   dispatch gate: dispatch / keep (manager does it) / clarify, with reasons
  omh dispatch <T> [--worker W] [--retry] [--force --reason R]   (refused unless triage says dispatch)
  omh review <T> [--reviewer W] [--count N]     cross-vendor read-only review(s)
  omh wait [T…] [--phase build|review|review-N] [--timeout-min M] [--any]
  omh verify <T> [--only 1,3]      manager-side: re-run the ticket's acceptance commands + scope check
  omh checks <T>                   acceptance profile that fits the actual change; prints commands, never runs them
  omh packet <T>                   one compact hand-off (state, changed files, checks, reviews, next step)
  omh accept <T> [--commit]        move to done/ (+ git commit), append to progress.md
  omh move <T> <open|doing|done|blocked|dropped> [--reason R] [--reset]   (--reset: zero the failure count when reopening)
  omh kill <T> [--phase P]   omh log <T> [--phase P] [--lines N]

Overview
  omh status                       running jobs, recent results, ready/blocked tickets, spend
  omh cost                         spend and job counts per worker
  omh quota                        quota pools: tier, used vs limit, remaining (free → subscription → paid)
  omh switch on|off|status         master switch: on = connect every task, off = dispatch nothing
  omh mcp                          run as an MCP server over stdio (for Claude Code)

Global: --root <dir> (default: nearest dir with .omh/ or _tickets/), --json`;

const BOOL = new Set(['json', 'mcp', 'retry', 'force', 'any', 'commit', 'full', 'keep', 'help', 'reset', 'version']);
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (v !== undefined) opt[key] = v;
      else if (!BOOL.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt[key] = argv[++i];
      else opt[key] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}
const list = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));

function printStatus(s) {
  const lines = [];
  lines.push(`tickets: ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(' · ')} | spent $${s.spentUsd}${s.budgetUsd != null ? ` / $${s.budgetUsd}` : ''}`);
  if (s.running.length) {
    lines.push('running:');
    for (const j of s.running) lines.push(`  ${j.ticket} ${j.phase} ${j.worker}  ${j.state} ${j.elapsed} (quiet ${j.quietFor}${j.idle ? ', IDLE?' : ''})`);
  } else lines.push('running: none');
  if (s.recent.length) {
    lines.push('recent:');
    for (const j of s.recent) {
      lines.push(`  ${j.ticket} ${j.phase} ${j.worker}  ${j.ok ? 'OK' : 'FAIL'} ${j.state} exit=${j.exitCode ?? '-'} ${j.elapsed}${j.receipt ? ` receipt=${j.receipt}` : ''}${j.costUsd != null ? ` $${j.costUsd}` : ''}${j.credits != null ? ` ${j.credits} credits` : ''}`);
      if (j.error) lines.push(`    why: ${j.error.length > 160 ? `${j.error.slice(0, 160)}…` : j.error}`);
    }
  }
  if (s.ready.length) lines.push(`ready: ${s.ready.join(', ')}`);
  for (const b of s.blocked) lines.push(`blocked: ${b.id} — ${b.reason}`);
  return lines.join('\n');
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  if (opt.version || cmd === 'version') {
    console.log(core.VERSION);
    return 0;
  }
  if (!cmd || opt.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === 'mcp') {
    const { serve } = await import('../src/mcp.js');
    await serve();
    return null;
  }
  const root = findRoot(opt.root || process.cwd());
  const need = (n, what) => {
    if (!pos[n]) throw new OmhError(`missing ${what}. See omh --help`, 'E_USAGE');
    return pos[n];
  };
  let out;
  let code = 0;
  switch (cmd) {
    case 'init': out = core.init(root, { mcp: !!opt.mcp }); break;
    case 'detect': out = core.detect(root); break;
    case 'probe': out = core.probe(root, need(0, 'adapter'), { full: !!opt.full }); code = out.ok ? 0 : 3; break;
    case 'workers': out = core.workers(root); break;
    case 'trial': out = await core.trial(root, need(0, 'worker'), { keep: !!opt.keep, timeoutSec: Number(opt.timeoutMin || 15) * 60 }); code = out.ok ? 0 : 3; break;
    case 'new':
      out = core.newTicket(root, { slug: need(0, 'slug'), title: opt.title, kind: opt.kind, depends: list(opt.depends), files: list(opt.files), workdir: opt.workdir, worker: opt.worker, lang: opt.lang });
      break;
    case 'next': out = core.next(root); break;
    case 'dispatch': out = core.dispatch(root, need(0, 'ticket'), { worker: opt.worker, retry: !!opt.retry, force: !!opt.force, reason: opt.reason }); break;
    case 'triage': out = core.triage(root, need(0, 'ticket')); code = out.decision === 'dispatch' ? 0 : 3; break;
    case 'quota': out = core.quota(root); break;
    case 'switch': {
      const v = pos[0] || 'status';
      if (v === 'on' || v === 'off') out = core.switchSet(root, v === 'on');
      else if (v === 'status') out = core.switchStatus(root);
      else throw new OmhError('usage: omh switch on|off|status', 'E_USAGE');
      break;
    }
    case 'review': out = core.review(root, need(0, 'ticket'), { reviewer: opt.reviewer, count: Number(opt.count || 1) }); break;
    case 'wait': {
      out = await core.wait(root, pos, { phase: opt.phase, any: !!opt.any, timeoutSec: Number(opt.timeoutMin || 60) * 60, pollMs: Number(process.env.OMH_POLL_MS) || 3000 });
      code = out.timedOut ? 2 : out.jobs.every((j) => j.ok) ? 0 : 3;
      break;
    }
    case 'verify': out = core.verify(root, need(0, 'ticket'), { only: opt.only, timeoutMin: opt.timeoutMin && Number(opt.timeoutMin) }); code = out.pass ? 0 : 3; break;
    case 'checks': out = core.checks(root, need(0, 'ticket')); break;
    case 'packet': out = packet(root, need(0, 'ticket')); break;
    case 'accept': out = core.move(root, need(0, 'ticket'), 'done', { commit: !!opt.commit, reason: opt.reason }); break;
    case 'move': out = core.move(root, need(0, 'ticket'), need(1, 'state'), { reason: opt.reason, reset: !!opt.reset }); break;
    case 'kill': out = core.kill(root, need(0, 'ticket'), { phase: opt.phase || 'build' }); break;
    case 'log': out = core.log(root, need(0, 'ticket'), { phase: opt.phase || 'build', lines: Number(opt.lines || 60) }); break;
    case 'status': out = core.status(root); break;
    case 'cost': out = core.cost(root); break;
    default: throw new OmhError(`unknown command "${cmd}". See omh --help`, 'E_USAGE');
  }
  if (cmd === 'status' && !opt.json) console.log(printStatus(out));
  else if (cmd === 'log' && !opt.json) console.log(`# ${out.file} (${out.state})\n${out.tail}`);
  else if (cmd === 'packet') console.log(JSON.stringify(out)); // one line: the size cap is the point
  else console.log(JSON.stringify(out, null, 2));
  return code;
}

main().then(
  (code) => {
    if (code !== null) process.exitCode = code;
  },
  (e) => {
    if (e instanceof OmhError) {
      console.error(JSON.stringify({ error: e.code, message: e.message }));
      process.exitCode = 1;
    } else {
      console.error(e.stack || String(e));
      process.exitCode = 1;
    }
  },
);
