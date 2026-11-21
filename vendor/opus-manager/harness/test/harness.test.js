import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expandTemplate, extractError } from '../src/adapters.js';
import { parseTicketText, serializeTicket, parseChecks } from '../src/tickets.js';
import { globToRegExp, matchesAny } from '../src/util.js';
import { parseNpmShim } from '../src/spawn.js';
import { recommendChecks, NO_MATCH } from '../src/checks.js';
import { loadConfig } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OMH = path.join(HERE, '..', 'bin', 'omh.js');
const FAKE = path.join(HERE, 'fixtures', 'fake-worker.js');

function project({ git = true, workers } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-home-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', OMH_HOME: home, OMH_TICK_MS: '150', OMH_POLL_MS: '150', OMH_ROOT: dir };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [OMH, ...args], { cwd: dir, env, encoding: 'utf8' });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    let err = null;
    try { err = JSON.parse(r.stderr); } catch {}
    return { ...r, json, err };
  };
  if (git) {
    spawnSync('git', ['init', '-q'], { cwd: dir, env });
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env });
  }
  assert.equal(run('init').status, 0);
  const cfgPath = path.join(dir, '.omh', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.adapters = {
    fake: { bin: process.execPath, binArgs: [FAKE], build: ['{prompt}'], review: ['--review', '{prompt}'], helpMustContain: [], finalAnswer: 'stdout', usage: 'generic' },
  };
  cfg.workers = workers || {
    builder: { adapter: 'fake', model: 'fake-1', vendor: 'acme', roles: ['build'], consent: { codeAccess: true, autoApprove: true } },
    builder2: { adapter: 'fake', model: 'fake-2', vendor: 'acme', roles: ['build'], consent: { codeAccess: true, autoApprove: true } },
    samevendor: { adapter: 'fake', model: 'r0', vendor: 'acme', roles: ['review'], consent: { codeAccess: true } },
    reviewer: { adapter: 'fake', model: 'r1', vendor: 'other', roles: ['review'], consent: { codeAccess: true } },
  };
  cfg.routing = { default: ['builder', 'builder2'] };
  cfg.review = { requireDifferentVendor: true, reviewers: ['samevendor', 'reviewer'] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const ticket = (slug, extraFm = '') => {
    const r = run('new', slug, '--title', `trial ${slug}`, '--files', 'add.js,add.test.js,package.json');
    assert.equal(r.status, 0, r.stderr);
    const p = r.json.path;
    let text = fs.readFileSync(p, 'utf8');
    text = text.replace(/## (验收|Acceptance)[^\n]*\n1\. `<[^`]+>`[^\n]*\n2\. `<[^`]+>`[^\n]*\n/, '## 验收\n1. `node add.test.js` → ok\n');
    text = text.replace(/<一句话：[^>]*>/, '新建 add.js 导出 add(a, b)，并写 add.test.js 断言结果。');
    text = text.replace(/^((?:\d+\.\s*|-\s*)?)<[^<>!\n]+>\s*$/gm, '$1（本测试不需要）');
    if (extraFm) text = text.replace(/\n---\n/, `\n${extraFm}\n---\n`);
    fs.writeFileSync(p, text);
    return r.json.id;
  };
  return { dir, env, run, ticket, cfgPath };
}

// ---------------------------------------------------------------- unit

test('expandTemplate drops optional groups with missing values', () => {
  const tpl = ['-p', ['--provider', '{provider}'], ['--model', '{model}'], '{prompt}'];
  assert.deepEqual(expandTemplate(tpl, { prompt: 'hi', model: 'm' }), ['-p', '--model', 'm', 'hi']);
  assert.deepEqual(expandTemplate(tpl, { prompt: 'hi', model: 'm', provider: 'x' }), ['-p', '--provider', 'x', '--model', 'm', 'hi']);
});

test('front matter round-trips and acceptance commands parse', () => {
  const text = serializeTicket({ id: 'T3', title: 'a: b', depends: ['T1', 'T2'], files: ['src/**'], worktree: true, n: 2 }, '# T3\n\n## 验收\n1. `npm test` → 全过\n2、 `node x.js` 打印 ok\n\n## 产出\n1. `nope`\n');
  const { fm, body } = parseTicketText(text);
  assert.deepEqual(fm, { id: 'T3', title: 'a: b', depends: ['T1', 'T2'], files: ['src/**'], worktree: true, n: 2 });
  assert.deepEqual(parseChecks(body).map((c) => c.cmd), ['npm test', 'node x.js']);
});

test('legacy opus-manager header is understood', () => {
  const { fm } = parseTicketText('# T1：x\n\n> 派单：Claude | 日期：2026-01-01\n> workdir: app\n> claimed-by: pi\n');
  assert.equal(fm.workdir, 'app');
});

test('glob matching', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(globToRegExp('src/*.js').test('src/a.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(matchesAny('./docs/x.md', ['docs/']));
  assert.ok(globToRegExp('**/*.test.js').test('a/b/c.test.js'));
});

test('npm cmd-shim target is parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-shim-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'tool', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'tool', 'bin', 'cli.js'), '');
  const shim = path.join(dir, 'tool.cmd');
  fs.writeFileSync(shim, '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\tool\\bin\\cli.js" %*\r\n');
  const t = parseNpmShim(shim);
  assert.ok(t && t.replace(/\\/g, '/').endsWith('node_modules/tool/bin/cli.js'), String(t));
});

test('a failed run records why it failed, in one line', () => {
  const claudeJson = '{"type":"result","is_error":true,"api_error_status":404,"result":"There\'s an issue with the selected model (claude-haiku-5-5). Run --model to pick a different model."}';
  assert.match(extractError(claudeJson), /selected model \(claude-haiku-5-5\)/);
  assert.equal(extractError('# omh build T1\n\nnpm ERR! code EACCES\npermission denied\n'), 'permission denied');
  assert.equal(extractError('total cost: $0.0100\nworking in /tmp\n'), null, 'no false positive on a clean log');
});

// ---------------------------------------------------------------- end to end

test('full loop: dispatch → wait → verify → review (cross-vendor) → accept', () => {
  const p = project();
  const id = p.ticket('add');
  const d = p.run('dispatch', id);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.json.worker, 'builder');
  assert.ok(fs.existsSync(path.join(p.dir, '_tickets', 'doing', `${id}-add.md`)));

  const w = p.run('wait', id, '--timeout-min', '1');
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.equal(w.json.jobs[0].ok, true);
  assert.equal(w.json.jobs[0].receipt, 'written');
  assert.equal(w.json.jobs[0].costUsd, 0.01);

  const signed = fs.readFileSync(path.join(p.dir, '_tickets', 'doing', `${id}-add.md`), 'utf8');
  assert.match(signed, /claimed_by: .*builder/);
  assert.match(signed, /base_sha: [0-9a-f]{40}/);

  const v = p.run('verify', id);
  assert.equal(v.status, 0, v.stdout);
  assert.equal(v.json.checks[0].pass, true);
  assert.deepEqual(v.json.scope.outOfScope, []);

  const r = p.run('review', id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.reviews[0].worker, 'reviewer', 'same-vendor reviewer must be skipped');
  const rw = p.run('wait', id, '--phase', 'review', '--timeout-min', '1');
  assert.equal(rw.status, 0, rw.stdout);
  const report = fs.readFileSync(path.join(p.dir, '_receipts', `${id}.review-1.md`), 'utf8');
  assert.match(report, /审查：fake-reviewer/);
  assert.ok(fs.existsSync(path.join(p.dir, '_receipts', `${id}.diff`)));

  const a = p.run('accept', id);
  assert.equal(a.status, 0, a.stderr);
  assert.ok(fs.existsSync(path.join(p.dir, '_tickets', 'done', `${id}-add.md`)));
  assert.match(fs.readFileSync(path.join(p.dir, '_receipts', 'progress.md'), 'utf8'), new RegExp(`${id} trial add \\| done`));

  const c = p.run('cost');
  assert.equal(c.json.byWorker.builder.jobs, 1);
  assert.ok(Math.abs(c.json.totalUsd - 0.0142) < 1e-9, String(c.json.totalUsd));
  const s = p.run('status');
  assert.equal(s.status, 0);
  assert.match(s.stdout, /done 1/);
});

test('scope check flags files outside `files:`', () => {
  const p = project();
  const id = p.ticket('scope');
  p.env.FAKE_MODE = 'outofscope';
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
  const v = p.run('verify', id);
  assert.equal(v.status, 3);
  assert.deepEqual(v.json.scope.outOfScope, ['extra.js']);
});

// A project whose earlier work was never committed: a tracked file edited, and two new files.
function withUncommittedWork(p) {
  const git = (...args) => spawnSync('git', args, { cwd: p.dir, env: p.env });
  fs.writeFileSync(path.join(p.dir, 'tracked.js'), '// committed\n');
  git('add', 'tracked.js');
  git('commit', '-q', '-m', 'tracked');
  fs.writeFileSync(path.join(p.dir, 'tracked.js'), '// edited, not committed\n');
  fs.writeFileSync(path.join(p.dir, 'old.js'), '// from an earlier ticket\n');
  fs.writeFileSync(path.join(p.dir, 'extra.js'), '// also from an earlier ticket\n');
}

test('scope check: uncommitted work from before the dispatch is not this ticket\'s change', () => {
  const p = project();
  withUncommittedWork(p);
  const id = p.ticket('inherited');
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
  const v = p.run('verify', id);
  assert.equal(v.status, 0, JSON.stringify(v.json.scope));
  assert.deepEqual(v.json.scope.outOfScope, []);
  assert.deepEqual(v.json.scope.changed.sort(), ['add.js', 'add.test.js', 'package.json']);
  assert.deepEqual(v.json.scope.preexisting.sort(), ['extra.js', 'old.js', 'tracked.js']);
});

test('scope check: an inherited file the worker changes still counts as out of scope', () => {
  const p = project();
  withUncommittedWork(p);
  const id = p.ticket('touched');
  p.env.FAKE_MODE = 'outofscope';
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
  const v = p.run('verify', id);
  assert.equal(v.status, 3);
  assert.deepEqual(v.json.scope.outOfScope, ['extra.js']);
  assert.ok(!v.json.scope.preexisting.includes('extra.js'));
});

test('scope check: an inherited untracked file that gets deleted still counts as out of scope', () => {
  const p = project();
  withUncommittedWork(p);
  const id = p.ticket('deleted');
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
  fs.rmSync(path.join(p.dir, 'old.js'));
  const v = p.run('verify', id);
  assert.equal(v.status, 3);
  assert.deepEqual(v.json.scope.outOfScope, ['old.js']);
});

test('scope check: a retry keeps the first baseline, so the first attempt\'s stray file stays out of scope', () => {
  const p = project();
  const id = p.ticket('retried');
  p.env.FAKE_MODE = 'outofscope';
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
  p.env.FAKE_MODE = 'ok';
  const again = p.run('dispatch', id, '--retry');
  assert.equal(again.status, 0, again.stderr);
  p.run('wait', id, '--timeout-min', '1');
  const v = p.run('verify', id);
  assert.equal(v.status, 3);
  assert.deepEqual(v.json.scope.outOfScope, ['extra.js']);
});

test('review diff: inherited files the worker left alone stay out of it', () => {
  const p = project();
  withUncommittedWork(p);
  const id = p.ticket('reviewed');
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
  assert.equal(p.run('review', id).status, 0);
  p.run('wait', id, '--phase', 'review', '--timeout-min', '1');
  const diff = fs.readFileSync(path.join(p.dir, '_receipts', `${id}.diff`), 'utf8');
  assert.ok(diff.includes('add.js'), diff);
  for (const name of ['old.js', 'extra.js', 'tracked.js']) assert.ok(!diff.includes(name), `${name} in\n${diff}`);
});

test('scope check: a ticket dispatched before baselines existed behaves as it did', () => {
  const p = project();
  fs.writeFileSync(path.join(p.dir, 'old.js'), '// from an earlier ticket\n');
  const id = p.ticket('legacy');
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
  fs.rmSync(path.join(p.dir, '.omh', 'jobs', `${id}.baseline.json`));
  const v = p.run('verify', id);
  assert.equal(v.status, 3);
  assert.deepEqual(v.json.scope.outOfScope, ['old.js']);
  assert.equal(v.json.scope.preexisting, undefined);
});

test('missing receipt = failure; retry keeps the same worker; too many attempts → blocked', () => {
  const p = project();
  const id = p.ticket('noreceipt');
  p.env.FAKE_MODE = 'noreceipt';
  p.run('dispatch', id);
  const w = p.run('wait', id, '--timeout-min', '1');
  assert.equal(w.status, 3);
  assert.equal(w.json.jobs[0].receipt, 'MISSING');
  assert.ok(w.json.jobs[0].logTail.includes('working in'));

  assert.equal(p.run('dispatch', id).err.error, 'E_STATE', 'needs --retry');
  const again = p.run('dispatch', id, '--retry');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.worker, 'builder');
  assert.equal(again.json.attempt, 2);
  p.run('wait', id, '--timeout-min', '1');
  const third = p.run('dispatch', id, '--retry');
  assert.equal(third.err.error, 'E_ATTEMPTS');
  assert.ok(fs.existsSync(path.join(p.dir, '_tickets', 'blocked', `${id}-noreceipt.md`)));
});

test('hard timeout kills the worker; kill command works', () => {
  const p = project();
  const id = p.ticket('slow', 'timeout_min: 0.02');
  p.env.FAKE_MODE = 'sleep';
  p.run('dispatch', id);
  const w = p.run('wait', id, '--timeout-min', '1');
  assert.equal(w.json.jobs[0].state, 'timeout');

  const id2 = p.ticket('slow2');
  p.run('dispatch', id2);
  const k = p.run('kill', id2);
  assert.equal(k.json.killed, true);
  const w2 = p.run('wait', id2, '--timeout-min', '1');
  assert.equal(w2.json.jobs[0].state, 'killed');

  // Regression (Windows): `omh kill` immediately after dispatch lands while the supervisor
  // is still "starting" and has not published the worker pid. Killing the supervisor at that
  // point used to freeze the status at "running", so the job read as "lost". It must read as
  // "killed" every time.
  for (let i = 0; i < 3; i++) {
    const id3 = p.ticket(`race${i}`);
    assert.equal(p.run('dispatch', id3).status, 0);
    const kk = p.run('kill', id3);
    assert.equal(kk.json.killed, true, `kill right after dispatch (round ${i})`);
    const w3 = p.run('wait', id3, '--timeout-min', '1');
    assert.equal(w3.json.jobs[0].state, 'killed', `round ${i}`);
  }
});

test('consent, dependencies, locking and concurrency', () => {
  const p = project({
    workers: { nope: { adapter: 'fake', vendor: 'x', roles: ['build'], consent: { codeAccess: true } } },
  });
  const cfg = JSON.parse(fs.readFileSync(p.cfgPath, 'utf8'));
  cfg.routing = { default: ['nope'] };
  fs.writeFileSync(p.cfgPath, JSON.stringify(cfg));
  const id = p.ticket('a');
  const d = p.run('dispatch', id);
  assert.equal(d.err.error, 'E_NO_WORKER');
  assert.match(d.err.message, /autoApprove/);

  cfg.workers.nope.consent.autoApprove = true;
  fs.writeFileSync(p.cfgPath, JSON.stringify(cfg));
  const id2 = p.ticket('b', `depends: [${id}]`);
  assert.equal(p.run('dispatch', id2).err.error, 'E_DEPS');
  const nx = p.run('next');
  assert.deepEqual(nx.json.find((t) => t.id === id2).waitingOn, [id]);

  p.env.FAKE_MODE = 'sleep';
  assert.equal(p.run('dispatch', id).status, 0);
  const id3 = p.ticket('c');
  assert.equal(p.run('dispatch', id3).err.error, 'E_BUSY', 'concurrency 1');
  assert.equal(p.run('dispatch', id).err.error, 'E_RUNNING');
  p.run('kill', id);
});

test('MCP server: initialize, list tools, call omh_status', async () => {
  const p = project();
  const child = spawn(process.execPath, [OMH, 'mcp'], { cwd: p.dir, env: p.env });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'omh_status', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'omh_dispatch', arguments: { ticket: 'T999' } } });
  const deadline = Date.now() + 5000;
  while (lines.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(byId[1].result.serverInfo.name, 'opus-harness');
  assert.ok(byId[2].result.tools.length >= 8);
  assert.ok(byId[2].result.tools.some((t) => t.name === 'omh_packet'), 'omh_packet is exposed over MCP');
  assert.ok(byId[2].result.tools.every((t) => t.inputSchema.type === 'object'));
  assert.ok(JSON.parse(byId[3].result.content[0].text).counts);
  assert.equal(byId[4].result.isError, true);
});

test('worktree isolation: build in .omh/worktrees/<T> on branch omh/<T>, commit there', () => {
  const p = project();
  const id = p.ticket('wt', 'worktree: true');
  const d = p.run('dispatch', id);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.json.workdir.replace(/\\/g, '/'), new RegExp(`\\.omh/worktrees/${id}$`));
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  assert.ok(!fs.existsSync(path.join(p.dir, 'add.js')), 'main checkout untouched');
  const v = p.run('verify', id);
  assert.equal(v.status, 0, v.stdout);
  assert.deepEqual(v.json.scope.changed.sort(), ['add.js', 'add.test.js', 'package.json']);
  const a = p.run('accept', id, '--commit');
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.json.commit, /^[0-9a-f]{40}$/);
  const br = spawnSync('git', ['log', '--oneline', `omh/${id}`], { cwd: p.dir, encoding: 'utf8' });
  assert.match(br.stdout, new RegExp(`${id}: trial wt`));
});

test('scope check handles non-ASCII file names', () => {
  const p = project();
  const id = p.ticket('cn');
  // allow only the Chinese file; the fake worker's files become out of scope
  const f = path.join(p.dir, '_tickets', 'open', `${id}-cn.md`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^files: .*$/m, 'files: [文档/说明.md]'));
  fs.mkdirSync(path.join(p.dir, '文档'));
  fs.writeFileSync(path.join(p.dir, '文档', '说明.md'), '你好\n');
  const v = p.run('verify', id);
  assert.ok(v.json.scope.changed.includes('文档/说明.md'), JSON.stringify(v.json.scope));
  assert.ok(!v.json.scope.outOfScope.includes('文档/说明.md'));
});

test('supervisor: a job cancelled before it starts never runs the worker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-sup-'));
  const marker = path.join(dir, 'ran.txt');
  const spec = {
    cmd: { file: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] },
    display: 'node -e …', cwd: dir, env: {}, stdinText: null,
    logFile: path.join(dir, 'job.log'), statusFile: path.join(dir, 'job.json'), eventsFile: path.join(dir, 'events.jsonl'),
    receiptFile: null, reportFile: null, lastMessageFile: path.join(dir, 'last.txt'), finalAnswer: 'stdout', usageParser: 'generic',
    timeoutMs: 60000, idleWarnMs: 60000, tickMs: 100, statusBase: { ticket: 'T1', phase: 'build', worker: 'w' },
  };
  const specPath = path.join(dir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  fs.writeFileSync(`${specPath}.kill`, 'now');
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'src', 'supervisor.js'), specPath], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(fs.readFileSync(spec.statusFile, 'utf8'));
  assert.equal(st.state, 'killed');
  assert.equal(st.ok, false);
  assert.ok(!fs.existsSync(marker), 'worker must not have run');
});

test('reopening a failed ticket keeps its failure count; only --reset zeroes it', () => {
  const p = project();
  const id = p.ticket('reopen');
  p.env.FAKE_MODE = 'noreceipt';
  assert.equal(p.run('dispatch', id).json.attempt, 1);
  p.run('wait', id, '--timeout-min', '1');
  assert.equal(p.run('move', id, 'open').status, 0);
  const d2 = p.run('dispatch', id);
  assert.equal(d2.json.attempt, 2, 'move open must not reset the count');
  assert.match(d2.json.log, /build-a2\.log$/, 'each attempt gets its own log');
  p.run('wait', id, '--timeout-min', '1');
  p.run('move', id, 'open');
  assert.equal(p.run('dispatch', id).err.error, 'E_ATTEMPTS', 'maxAttempts still protects');
  assert.equal(p.run('move', id, 'open', '--reset').status, 0);
  assert.equal(p.run('dispatch', id).json.attempt, 1);
  p.run('wait', id, '--timeout-min', '1');
});

test('accept --commit commits only the ticket and leaves the tree clean', () => {
  const p = project();
  fs.writeFileSync(path.join(p.dir, 'notes.txt'), 'unrelated work in progress\n');
  const id = p.ticket('commit');
  p.run('dispatch', id);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  const a = p.run('accept', id, '--commit');
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(a.json.notCommitted, ['notes.txt']);
  const files = spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const f of ['add.js', 'add.test.js', 'package.json', `_tickets/done/${id}-commit.md`, '_receipts/progress.md', '_receipts/events.jsonl', `_receipts/${id}-commit.receipt.md`]) {
    assert.ok(files.includes(f), `${f} should be committed; got ${files.join(', ')}`);
  }
  assert.ok(!files.includes('notes.txt'), 'out-of-scope work must not be committed');
  assert.ok(!files.some((f) => /\.log$|\.build\.json$/.test(f)), `logs/status must not be committed: ${files.join(', ')}`);
  // .omh/ (the project's harness config) is the user's to commit; it is not part of the ticket
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: p.dir, encoding: 'utf8' }).stdout.split('\n').filter((l) => l && !l.endsWith('.omh/'));
  assert.deepEqual(st, ['?? notes.txt'], 'nothing of the ticket left uncommitted');
});

test('a failed review leaves no report', () => {
  const p = project();
  const id = p.ticket('badreview');
  p.run('dispatch', id);
  p.run('wait', id, '--timeout-min', '1');
  p.env.FAKE_MODE = 'reviewfail';
  assert.equal(p.run('review', id).status, 0);
  const w = p.run('wait', id, '--phase', 'review', '--timeout-min', '1');
  assert.equal(w.status, 3);
  assert.equal(w.json.jobs[0].report, 'MISSING');
  assert.match(w.json.jobs[0].error, /model not supported/);
  assert.ok(!fs.existsSync(path.join(p.dir, '_receipts', `${id}.review-1.md`)));
});

test('config written with a UTF-8 BOM (Windows Notepad / PowerShell 5) still loads', () => {
  const p = project();
  const raw = fs.readFileSync(p.cfgPath, 'utf8');
  fs.writeFileSync(p.cfgPath, '\uFEFF' + raw);
  const w = p.run('workers');
  assert.equal(w.status, 0, w.stderr);
  assert.ok(w.json.some((x) => x.id === 'builder'), 'workers from the BOM-prefixed config must be visible');
});

test('omh --version prints the version', () => {
  const r = spawnSync(process.execPath, [OMH, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('cost: a worker that never reports cost shows null, not $0', () => {
  const p = project();
  const id = p.ticket('nocost');
  p.env.FAKE_MODE = 'nocost';
  p.run('dispatch', id);
  p.run('wait', id, '--timeout-min', '1');
  const c = p.run('cost');
  assert.equal(c.json.byWorker.builder.costUsd, null);
  assert.equal(c.json.byWorker.builder.costReportedJobs, 0);
  assert.equal(c.json.byWorker.builder.jobs, 1);
});

test('commitMessage template (e.g. Conventional Commits)', () => {
  const p = project();
  const cfg = JSON.parse(fs.readFileSync(p.cfgPath, 'utf8'));
  cfg.commitMessage = 'feat({kind}): {title} ({id})';
  fs.writeFileSync(p.cfgPath, JSON.stringify(cfg));
  const id = p.ticket('cc');
  p.run('dispatch', id);
  p.run('wait', id, '--timeout-min', '1');
  assert.equal(p.run('accept', id, '--commit').status, 0);
  const msg = spawnSync('git', ['log', '-1', '--format=%s'], { cwd: p.dir, encoding: 'utf8' }).stdout.trim();
  assert.equal(msg, `feat(default): trial cc (${id})`);
});

test('review prompt tells reviewers to read files as UTF-8', async () => {
  const { reviewPrompt } = await import('../src/prompts.js');
  const v = { ticket: 't', receipt: 'r', scope: 's', builder: 'b', engine: 'e', time: 'now' };
  assert.match(reviewPrompt('zh', v), /Get-Content -Encoding UTF8/);
  assert.match(reviewPrompt('en', v), /Get-Content -Encoding UTF8/);
});

test('claude usage keeps cache read/write tokens visible', async () => {
  const { parseUsage } = await import('../src/adapters.js');
  const u = parseUsage('claude-json', '{"total_cost_usd":0.0088,"num_turns":10,"usage":{"input_tokens":12,"cache_read_input_tokens":200000,"cache_creation_input_tokens":20982,"output_tokens":3573}}');
  assert.equal(u.cacheReadTokens, 200000);
  assert.equal(u.cacheWriteTokens, 20982);
  assert.equal(u.inputTokens, 220994);
});

test('codebuddy (WorkBuddy CLI) preset: -y for builds, read-only plan mode for reviews', async () => {
  const { PRESETS, buildArgs, getAdapter } = await import('../src/adapters.js');
  assert.ok(PRESETS.codebuddy);
  const a = getAdapter({ adapters: {} }, 'codebuddy');
  assert.deepEqual(buildArgs(a, 'build', { prompt: 'P', model: 'm' }), ['-p', 'P', '--model', 'm', '-y', '--output-format', 'stream-json']);
  const r = buildArgs(a, 'review', { prompt: 'P' });
  assert.ok(r.includes('plan') && !r.includes('-y'), r.join(' '));
});

test('commandcode preset: a build needs --yolo, a review stays in read-only plan mode', async () => {
  const { PRESETS, buildArgs, getAdapter } = await import('../src/adapters.js');
  assert.ok(PRESETS.commandcode);
  const a = getAdapter({ adapters: {} }, 'commandcode');
  const b = buildArgs(a, 'build', { prompt: 'P', model: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(b.slice(0, 4), ['-p', 'P', '--model', 'z-ai/glm-5.3-flash']);
  assert.ok(b.includes('--yolo'), b.join(' '));
  assert.equal(b[b.indexOf('--output-format') + 1], 'json');
  const r = buildArgs(a, 'review', { prompt: 'P' });
  assert.equal(r[r.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(!r.includes('--yolo') && !r.includes('--model'), r.join(' '));
  for (const args of [b, r]) for (const flag of ['--trust', '--skip-onboarding', '--no-auto-update']) assert.ok(args.includes(flag), flag);
});

test('codex preset: a build writes inside the workspace sandbox without --full-auto, which codex-cli 0.165 removed', async () => {
  const { buildArgs, getAdapter } = await import('../src/adapters.js');
  const a = getAdapter({ adapters: {} }, 'codex');
  const b = buildArgs(a, 'build', { prompt: 'P', model: 'm', lastMessageFile: 'L' });
  assert.ok(!b.includes('--full-auto'), b.join(' '));
  assert.equal(b[b.indexOf('--sandbox') + 1], 'workspace-write');
  const r = buildArgs(a, 'review', { prompt: 'P', model: 'm', lastMessageFile: 'L' });
  assert.equal(r[r.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(!a.helpMustContain.includes('--full-auto'), a.helpMustContain.join(' '));
});

test('commandcode real run: the answer, tokens and turns are read from its result line, the cost stays unknown', async () => {
  const { parseUsage, extractFinalAnswer, getAdapter } = await import('../src/adapters.js');
  const log = fs.readFileSync(path.join(HERE, 'fixtures', 'commandcode-stream-real.jsonl'), 'utf8');
  const a = getAdapter({ adapters: {} }, 'commandcode');
  const result = JSON.parse(log.trim().split('\n').pop());
  assert.equal(extractFinalAnswer(a.finalAnswer, log), result.finalText);
  const u = parseUsage(a.usage, log);
  assert.equal(u.costUsd, null);
  assert.equal(u.inputTokens, result.usage.inputTokens);
  assert.equal(u.outputTokens, result.usage.outputTokens);
  assert.equal(u.cacheReadTokens, result.usage.cacheReadTokens);
  assert.ok(u.turns >= 1, JSON.stringify(u));
});

test('commandcode: a run that failed gives its error, and its answer is not read as a success', async () => {
  const { extractError, extractFinalAnswer } = await import('../src/adapters.js');
  const failed = '{"type":"event","event":{"type":"run_start"}}\n{"type":"result","subtype":"error","durationMs":5,"finalText":"","error":"Connection failed"}\n';
  assert.equal(extractError(failed), 'Connection failed');
  assert.equal(extractFinalAnswer('commandcode-json', failed), failed);
});

test('codebuddy JSON (array of events): answer, credits and tokens are read from it', async () => {
  const { parseUsage, extractFinalAnswer, buildArgs, getAdapter } = await import('../src/adapters.js');
  const log = fs.readFileSync(path.join(HERE, 'fixtures', 'codebuddy-output.json'), 'utf8');
  assert.equal(extractFinalAnswer('claude-json', log), 'ok', 'the report must be the answer, not raw JSON');
  const u = parseUsage('codebuddy-json', log);
  assert.equal(u.costUsd, null, 'credits are not dollars');
  assert.equal(u.credits, 0.36);
  assert.equal(u.inputTokens, 25160);
  const a = getAdapter({ adapters: {} }, 'codebuddy');
  assert.deepEqual(buildArgs(a, 'build', { prompt: 'P', model: 'deepseek-v4.1-flash', effort: 'high' }), ['-p', 'P', '--model', 'deepseek-v4.1-flash', '--effort', 'high', '-y', '--output-format', 'stream-json']);
});

test('accept --commit works when the project keeps _tickets/_receipts out of git', () => {
  const p = project();
  fs.appendFileSync(path.join(p.dir, '.gitignore'), '_tickets/\n_receipts/\n.omh/\n');
  spawnSync('git', ['add', '.gitignore'], { cwd: p.dir, env: p.env });
  spawnSync('git', ['commit', '-q', '-m', 'ignore records'], { cwd: p.dir, env: p.env });
  const id = p.ticket('ignored');
  p.run('dispatch', id);
  p.run('wait', id, '--timeout-min', '1');
  const a = p.run('accept', id, '--commit');
  assert.equal(a.status, 0, a.stderr);
  const files = spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: p.dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ['add.js', 'add.test.js', 'package.json']);
});

test('a supervisor that stops heartbeating is reported lost, with when it was last seen', async () => {
  const p = project();
  const id = p.ticket('hb');
  p.run('dispatch', id);
  p.run('wait', id, '--timeout-min', '1');
  // simulate a supervisor that vanished 10 minutes ago while "running" (machine slept / host closed)
  const f = path.join(p.dir, '_receipts', `${id}.build.json`);
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(st, { state: 'running', endedAt: undefined, ok: undefined, heartbeatAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), supervisorPid: process.pid });
  fs.writeFileSync(f, JSON.stringify(st));
  const s = p.run('status', '--json');
  const j = s.json.recent.find((x) => x.ticket === id) || s.json.running.find((x) => x.ticket === id);
  assert.equal(j.state, 'lost', 'a live PID must not hide a stale heartbeat (PID reuse)');
  assert.equal(j.supervisorLastSeen, st.heartbeatAt);
  assert.match(j.note, /last seen/);
  // a fresh heartbeat is running
  st.heartbeatAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(st));
  assert.equal(p.run('status', '--json').json.running.find((x) => x.ticket === id).state, 'running');
});

test('live jobs carry a heartbeat', () => {
  const p = project();
  const id = p.ticket('hb2');
  p.env.FAKE_MODE = 'sleep';
  p.run('dispatch', id);
  const deadline = Date.now() + 5000;
  let st;
  while (Date.now() < deadline) {
    st = JSON.parse(fs.readFileSync(path.join(p.dir, '_receipts', `${id}.build.json`), 'utf8'));
    if (st.heartbeatAt && st.state === 'running') break;
  }
  assert.ok(st.heartbeatAt, 'heartbeatAt written');
  assert.ok(Date.now() - Date.parse(st.heartbeatAt) < 5000);
  p.run('kill', id);
});

test('codebuddy stream-json (JSON lines): answer and credits are read', async () => {
  const { parseUsage, extractFinalAnswer, getAdapter, buildArgs } = await import('../src/adapters.js');
  const log = fs.readFileSync(path.join(HERE, 'fixtures', 'codebuddy-stream.jsonl'), 'utf8');
  assert.equal(extractFinalAnswer('claude-json', log), 'ok');
  const u = parseUsage('codebuddy-json', log);
  assert.equal(u.credits, 0.36);
  assert.equal(u.inputTokens, 25160);
  const a = getAdapter({ adapters: {} }, 'codebuddy');
  assert.ok(buildArgs(a, 'build', { prompt: 'P' }).includes('stream-json'));
});

test('WMI launch command quotes paths and arguments safely', async () => {
  const { wmiLaunchCommand } = await import('../src/spawn.js');
  const c = wmiLaunchCommand("C:\\omh\\sup'er.js", ['C:\\a b\\x.spec.json'], "D:\\项目 x");
  assert.match(c, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.ok(c.includes("sup''er.js"), 'single quotes doubled inside the PowerShell literal');
  assert.ok(c.includes('"C:\\a b\\x.spec.json"'), 'arguments with spaces are double-quoted');
  assert.ok(c.includes("CurrentDirectory = 'D:\\项目 x'"));
});

// ---------------------------------------------------------------- stage 1: switch, triage, quota

function setCfg(p, mutate) {
  const cfg = JSON.parse(fs.readFileSync(p.cfgPath, 'utf8'));
  mutate(cfg);
  fs.writeFileSync(p.cfgPath, JSON.stringify(cfg, null, 2));
}
function editTicket(p, id, fn) {
  const dir = path.join(p.dir, '_tickets', 'open');
  const f = path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith(`${id}-`)));
  fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8')));
}

test('master switch: manual by default, off refuses dispatch, on reports readiness', () => {
  const p = project();
  assert.equal(p.run('switch', 'status').json.mode, 'manual');
  assert.equal(p.run('switch', 'off').json.mode, 'off');
  const id = p.ticket('sw');
  const d = p.run('dispatch', id);
  assert.equal(d.err.error, 'E_OFF');
  const on = p.run('switch', 'on').json;
  assert.equal(on.mode, 'on');
  assert.equal(on.ready, true);
  assert.deepEqual(on.readyBuilders.sort(), ['builder', 'builder2']);
  assert.equal(p.run('dispatch', id).status, 0);
  p.run('wait', id, '--timeout-min', '1');
});

test('triage: a template placeholder left in the ticket goes back, since the worker cannot ask what it meant', () => {
  const p = project();
  const id = p.ticket('placeholder');
  editTicket(p, id, (t) => `${t}\n## 动手前先读\n1. <这次改动涉及的文件>\n`);
  const r = p.run('triage', id);
  assert.equal(r.json.decision, 'clarify');
  assert.equal(r.status, 3);
  assert.match(r.json.reasons.join(' '), /placeholder.*这次改动涉及的文件/);
  assert.notEqual(p.run('dispatch', id).status, 0);
});

test('triage: a ticket leaning on a conversation the worker never saw goes back', () => {
  const p = project();
  for (const words of ['按上次说的做', '和之前那个一样', 'do it as discussed']) {
    const id = p.ticket('dangling');
    editTicket(p, id, (t) => t.replace(/新建 add\.js[^\n]*/, `新建 add.js，${words}`));
    const r = p.run('triage', id);
    assert.equal(r.json.decision, 'clarify', words);
    assert.match(r.json.reasons.join(' '), /only sees this ticket/, words);
  }
});

test('triage: the same words inside code or a comment are not a reference to anything', () => {
  const p = project();
  const id = p.ticket('incode');
  editTicket(p, id, (t) => `${t}\n<!-- 上次 -->\n\n输出示例：\n\`\`\`\n<上次的结果>\n\`\`\`\n命令 \`grep 同上 a.txt\` 不算。\n`);
  const r = p.run('triage', id);
  assert.equal(r.json.decision, 'dispatch', r.json.reasons.join(' '));
});

test('triage: dispatch only scoped, decidable, worthwhile tickets', () => {
  const p = project();
  const ok = p.ticket('fine');
  assert.equal(p.run('triage', ok).json.decision, 'dispatch');

  const noChecks = p.ticket('nochecks');
  editTicket(p, noChecks, (t) => t.replace(/1\. `node add\.test\.js`[^\n]*\n/, ''));
  const r1 = p.run('triage', noChecks);
  assert.equal(r1.json.decision, 'clarify');
  assert.equal(r1.status, 3);
  assert.match(r1.json.reasons.join(' '), /no acceptance commands/);

  const vague = p.ticket('vague');
  editTicket(p, vague, (t) => t.replace(/新建 add\.js[^\n]*/, '看看能不能优化一下性能'));
  assert.equal(p.run('triage', vague).json.decision, 'clarify');

  const risky = p.ticket('risky', 'kind: security');
  assert.equal(p.run('triage', risky).json.decision, 'keep');
  const trivial = p.ticket('tiny', 'complexity: 1');
  assert.equal(p.run('triage', trivial).json.decision, 'keep');

  // dispatch refuses; --force needs a reason and is recorded
  assert.equal(p.run('dispatch', risky).err.error, 'E_TRIAGE');
  assert.equal(p.run('dispatch', risky, '--force').err.error, 'E_USAGE');
  assert.equal(p.run('dispatch', risky, '--force', '--reason', 'user asked to delegate this one').status, 0);
  p.run('wait', risky, '--timeout-min', '1');
  const ev = fs.readFileSync(path.join(p.dir, '_receipts', 'events.jsonl'), 'utf8');
  assert.match(ev, /"type":"triage-override".*user asked to delegate/);
});

test('quota-first routing: free before subscription, paid only when allowed, never above capability', () => {
  const p = project();
  setCfg(p, (c) => {
    c.workers.builder.quota = 'paid';
    c.workers.builder2.quota = 'subscription';
    c.workers.freebie = { adapter: 'fake', vendor: 'acme', roles: ['build'], quota: 'free', maxComplexity: 2, consent: { codeAccess: true, autoApprove: true } };
    c.routing = { default: ['builder', 'builder2', 'freebie'] };
  });
  const easy = p.ticket('easy', 'complexity: 2');
  assert.equal(p.run('dispatch', easy).json.worker, 'freebie', 'free quota first');
  p.run('wait', easy, '--timeout-min', '1');
  const hard = p.ticket('hard', 'complexity: 4');
  assert.equal(p.run('dispatch', hard).json.worker, 'builder2', 'free worker not rated for 4; subscription next; paid not allowed');
  p.run('wait', hard, '--timeout-min', '1');
  setCfg(p, (c) => { c.workers.builder2.disabled = true; });
  const hard2 = p.ticket('hard2', 'complexity: 4');
  const d = p.run('dispatch', hard2);
  assert.equal(d.err.error, 'E_NO_WORKER', 'never silently upgrades to a paid worker');
  assert.match(d.err.message, /paidAllowed/);
  setCfg(p, (c) => { c.workers.builder.paidAllowed = true; });
  assert.equal(p.run('dispatch', hard2).json.worker, 'builder');
  p.run('wait', hard2, '--timeout-min', '1');
});

test('quota pools: a used-up pool is skipped, with the reason, and reported', () => {
  const p = project();
  setCfg(p, (c) => {
    c.workers.builder.quota = 'free';
    c.workers.builder.quotaPool = 'platformA';
    c.workers.builder2.quota = 'subscription';
    c.quotaPools = { platformA: { jobs: 1, period: 'day' } };
  });
  const a = p.ticket('a');
  assert.equal(p.run('dispatch', a).json.worker, 'builder');
  p.run('wait', a, '--timeout-min', '1');
  const b = p.ticket('b');
  assert.equal(p.run('dispatch', b).json.worker, 'builder2', 'pool used up → next tier');
  p.run('wait', b, '--timeout-min', '1');
  const q = p.run('quota').json;
  assert.equal(q.pools.platformA.used.jobs, 1);
  assert.equal(q.pools.platformA.exhausted, true);
  assert.equal(q.pools.platformA.tier, 'free');
});

test('codebuddy real stream-json run: answer read, credits unknown (not 0), tool overhead visible', async () => {
  const { parseUsage, extractFinalAnswer, getAdapter, buildArgs } = await import('../src/adapters.js');
  const log = fs.readFileSync(path.join(HERE, 'fixtures', 'codebuddy-stream-real.jsonl'), 'utf8');
  assert.equal(extractFinalAnswer('claude-json', log), 'ok');
  const u = parseUsage('codebuddy-json', log);
  assert.equal(u.credits, null, 'stream-json carries no credit field: unknown, not 0');
  assert.equal(u.inputTokens, 25160);
  assert.equal(u.contextOverhead.tools, 22064);
  const a = getAdapter({ adapters: {} }, 'codebuddy');
  const args = buildArgs(a, 'build', { prompt: 'P', tools: 'Read,Write,Edit,Bash,Glob,Grep' });
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read,Write,Edit,Bash,Glob,Grep']);
  assert.ok(!buildArgs(a, 'build', { prompt: 'P' }).includes('--tools'), 'no --tools unless configured');
});

// ---------------------------------------------------------------- stage 2: the hand-off packet

test('omh packet: says verify first, then reports the independent evidence next to the claims', () => {
  const p = project();
  const id = p.ticket('packet');
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  // a receipt that claims a command (the fake worker writes no evidence section)
  fs.writeFileSync(
    path.join(p.dir, '_receipts', `${id}-packet.receipt.md`),
    '# 回执\n\n## 2. 文件清单\n- `add.js`\n- `add.test.js`\n\n## 3. 验收证据\n### 3.1 验收\n命令：`node add.test.js`\n\n## 4. 风险与存疑\n无\n',
  );

  const before = p.run('packet', id);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.json.ticket.id, id);
  assert.equal(before.json.ticket.state, 'doing');
  assert.equal(before.json.ticket.attempt, 1);
  assert.match(before.json.ticket.claimed_by, /builder/);
  assert.equal(before.json.build.state, 'exited');
  assert.equal(before.json.build.ok, true);
  assert.equal(before.json.build.exitCode, 0);
  assert.equal(before.json.build.usage.costUsd, 0.01);
  assert.equal(before.json.receipt.exists, true);
  assert.deepEqual(before.json.receipt.claims, ['node add.test.js'], 'claims are what the worker says it ran');
  assert.equal(before.json.verify.ran, false);
  assert.deepEqual(before.json.changedFiles.slice().sort(), ['add.js', 'add.test.js', 'package.json']);
  assert.match(before.json.next, /omh verify/, 'no evidence yet → verify');

  const v = p.run('verify', id);
  assert.equal(v.status, 0, v.stdout);
  const saved = JSON.parse(fs.readFileSync(path.join(p.dir, '_receipts', `${id}.verify.json`), 'utf8'));
  assert.deepEqual(saved, v.json, 'verify.json is the verify result, verbatim');

  const after = p.run('packet', id);
  assert.equal(after.json.verify.ran, true);
  assert.equal(after.json.verify.pass, true);
  assert.deepEqual(after.json.verify.checks.map((c) => ({ cmd: c.cmd, pass: c.pass, exit: c.exit })), [{ cmd: 'node add.test.js', pass: true, exit: 0 }]);
  assert.deepEqual(after.json.verify.outOfScope, []);
  assert.match(after.json.next, /omh review/, 'verify passed, no review yet → review');
});

test('omh packet: review rounds, severity counts, and whether the manager checked them', () => {
  const p = project();
  const id = p.ticket('pkrev');
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  assert.equal(p.run('verify', id).status, 0);
  assert.equal(p.run('review', id).status, 0);
  assert.equal(p.run('wait', id, '--phase', 'review', '--timeout-min', '1').status, 0);

  const a = p.run('packet', id);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.json.reviews.length, 1);
  assert.match(a.json.reviews[0].file, new RegExp(`${id}\\.review-1\\.md$`));
  assert.match(a.json.reviews[0].firstLine, /^审查：fake-reviewer/);
  assert.deepEqual(a.json.reviews[0].counts, { high: 0, medium: 0, low: 1 });
  assert.equal(a.json.reviews[0].managerChecked, false);
  assert.match(a.json.next, /核实/, 'findings are not checked yet');

  // prose that merely mentions the phrase is not a verdict: only a heading counts
  fs.appendFileSync(path.join(p.dir, '_receipts', `${id}.review-1.md`), '\n经理核实：还没看\n');
  const b = p.run('packet', id);
  assert.equal(b.json.reviews[0].managerChecked, false, 'a mention in the body is not the manager verdict');

  // the manager appends its own verdict at the end of the report
  fs.appendFileSync(path.join(p.dir, '_receipts', `${id}.review-1.md`), '\n## 经理核实\n- 低｜add.js:1｜不成立：示例\n');
  const c = p.run('packet', id);
  assert.equal(c.json.reviews[0].managerChecked, true);
  assert.deepEqual(c.json.reviews[0].counts, { high: 0, medium: 0, low: 1 }, 'the manager section is not a finding');
  assert.match(c.json.next, /omh accept/, 'checked → accept');
});

test('omh packet: stays within 6000 characters however big the receipt, verify file and reports are', async () => {
  const { packet } = await import('../src/packet.js');
  const p = project();
  const id = p.ticket('big');
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  assert.equal(p.run('verify', id).status, 0);

  const claims = Array.from({ length: 60 }, (_, i) => `命令：\`node --test very/long/path/number-${i}.test.js --reporter=spec --flag=abcdefghij\``).join('\n');
  fs.writeFileSync(path.join(p.dir, '_receipts', `${id}-big.receipt.md`), `# 回执\n\n## 3. 验收证据\n${claims}\n`);
  const vj = path.join(p.dir, '_receipts', `${id}.verify.json`);
  const v = JSON.parse(fs.readFileSync(vj, 'utf8'));
  v.checks[0].cmd = `node ${'y'.repeat(300)}`;
  v.checks[0].output = 'x'.repeat(4000);
  // enough checks that the trimming really has to run, not just the size cap
  for (let i = 0; i < 40; i++) v.checks.push({ n: i + 2, cmd: `node ${'z'.repeat(300)}-${i}`, exit: 0, pass: true, ms: 1 });
  fs.writeFileSync(vj, JSON.stringify(v));
  for (let n = 1; n <= 8; n++) {
    const findings = Array.from({ length: 200 }, (_, i) => `低｜file${i}.js:1｜${'问题'.repeat(30)}｜证据｜改法`).join('\n');
    fs.writeFileSync(path.join(p.dir, '_receipts', `${id}.review-${n}.md`), `审查：big @ now ${'x'.repeat(300)}\n${findings}\n`);
    // a round counts only when its status file says it reviewed the current attempt
    fs.writeFileSync(path.join(p.dir, '_receipts', `${id}.review-${n}.json`), JSON.stringify({ ticket: id, phase: `review-${n}`, buildAttempt: 1, state: 'exited', ok: true }));
  }

  const direct = packet(p.dir, id);
  assert.ok(JSON.stringify(direct).length <= 6000, `packet is ${JSON.stringify(direct).length} chars`);
  assert.equal(direct.ticket.id, id);
  assert.ok(direct.next, 'the next step survives the trimming');
  assert.equal(direct.truncated, true, 'trimming is reported, not silent');
  assert.ok(direct.reviews.length <= 5, `reviews kept ${direct.reviews.length}, expected the list to be cut`);

  const cli = p.run('packet', id);
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.trim().length <= 6000, `CLI printed ${cli.stdout.trim().length} chars`);
  assert.equal(cli.json.ticket.id, id);
});

test('omh packet: evidence from an earlier attempt is stale after --retry', () => {
  const p = project();
  const id = p.ticket('stale');
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  assert.equal(p.run('verify', id).status, 0);
  assert.equal(p.run('review', id).status, 0);
  assert.equal(p.run('wait', id, '--phase', 'review', '--timeout-min', '1').status, 0);
  fs.appendFileSync(path.join(p.dir, '_receipts', `${id}.review-1.md`), '\n## 经理核实\n- 低｜add.js:1｜不成立：示例\n');

  const before = p.run('packet', id);
  assert.equal(before.json.ticket.attempt, 1);
  assert.equal(before.json.verify.ran, true);
  assert.equal(before.json.reviews.length, 1);
  assert.equal(before.json.staleReviews, 0);
  assert.match(before.json.next, /omh accept/, 'attempt 1 evidence is complete');

  const retry = p.run('dispatch', id, '--retry');
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.json.attempt, 2);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);

  const after = p.run('packet', id);
  assert.equal(after.json.ticket.attempt, 2);
  assert.equal(after.json.verify.ran, false, 'attempt 1 verify is not evidence for attempt 2');
  assert.equal(after.json.verify.note, 'stale: verified attempt 1, current attempt 2');
  assert.deepEqual(after.json.reviews, [], 'attempt 1 review is not evidence for attempt 2');
  assert.ok(after.json.staleReviews >= 1, `staleReviews=${after.json.staleReviews}`);
  assert.doesNotMatch(after.json.next, /accept/);
});

test('omh packet: verify --only is partial, never a whole-ticket pass', () => {
  const p = project();
  const id = p.ticket('only');
  editTicket(p, id, (t) => t.replace(/(## 验收\n1\. `node add\.test\.js`[^\n]*\n)/, (m) => `${m}2. \`node add.test.js --second\` → 第二条\n`));
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);

  const v = p.run('verify', id, '--only', '1');
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(v.json.partial, true);
  assert.equal(v.json.attempt, 1);
  assert.equal(v.json.checks.length, 1);

  const pk = p.run('packet', id);
  assert.equal(pk.status, 0, pk.stderr);
  assert.equal(pk.json.verify.ran, true);
  assert.equal(pk.json.verify.partial, true);
  assert.equal(pk.json.verify.pass, false, 'one of two checks is not a pass');
  assert.match(pk.json.verify.note, /partial/);
  assert.match(pk.json.next, /omh verify/);
  assert.doesNotMatch(pk.json.next, /accept/);
});

test('omh packet: 50 changed/out-of-scope paths over 300 chars still fit in 6000', async () => {
  const { packet } = await import('../src/packet.js');
  const p = project();
  const id = p.ticket('longpath');
  // Windows: paths over MAX_PATH need git's long-path support, or git will not list them
  assert.equal(spawnSync('git', ['config', 'core.longpaths', 'true'], { cwd: p.dir, env: p.env }).status, 0);
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  const dirs = Array.from({ length: 5 }, (_, i) => `d${i}-${'x'.repeat(40)}`);
  fs.mkdirSync(path.join(p.dir, ...dirs), { recursive: true });
  const long = [];
  for (let i = 0; i < 50; i++) {
    const name = `f${String(i).padStart(2, '0')}-${'y'.repeat(100)}.js`;
    fs.writeFileSync(path.join(p.dir, ...dirs, name), '// out of scope on purpose\n');
    long.push([...dirs, name].join('/'));
  }
  assert.equal(long.length, 50);
  assert.ok(long.every((f) => f.length > 300), `shortest path is ${Math.min(...long.map((f) => f.length))} chars`);

  p.run('verify', id);
  const direct = packet(p.dir, id);
  assert.ok(direct.changedFiles.length > 0);
  assert.ok(direct.verify.outOfScope.length > 0);
  const json = JSON.stringify(direct);
  assert.ok(json.length <= 6000, `packet is ${json.length} chars`);
  assert.equal(direct.truncated, true);
  assert.equal(direct.ticket.id, id);
  assert.ok(direct.next, 'the next step survives the trimming');

  const cli = p.run('packet', id);
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.trim().length <= 6000, `CLI printed ${cli.stdout.trim().length} chars`);
});

test('omh packet: a failed review round does not hide the round after it', () => {
  const p = project();
  const id = p.ticket('pkfail');
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
  assert.equal(p.run('verify', id).status, 0);

  // round 1 fails: the reviewer exits non-zero, so only the status file is written
  p.env.FAKE_MODE = 'reviewfail';
  assert.equal(p.run('review', id).status, 0);
  assert.notEqual(p.run('wait', id, '--phase', 'review', '--timeout-min', '1').status, 0);
  assert.ok(fs.existsSync(path.join(p.dir, '_receipts', `${id}.review-1.json`)), 'the failed round is numbered by its json');
  assert.ok(!fs.existsSync(path.join(p.dir, '_receipts', `${id}.review-1.md`)));

  // round 2 succeeds
  delete p.env.FAKE_MODE;
  assert.equal(p.run('review', id).status, 0);
  const w = p.run('wait', id, '--phase', 'review', '--timeout-min', '1');
  assert.equal(w.status, 0, w.stdout);
  assert.ok(fs.existsSync(path.join(p.dir, '_receipts', `${id}.review-2.md`)));

  const pk = p.run('packet', id);
  assert.equal(pk.status, 0, pk.stderr);
  assert.equal(pk.json.reviews.length, 1, 'the report after the failed round is visible');
  assert.match(pk.json.reviews[0].file, new RegExp(`${id}\\.review-2\\.md$`));
  assert.deepEqual(pk.json.reviews[0].counts, { high: 0, medium: 0, low: 1 });
  assert.equal(pk.json.failedReviews, 1);
  assert.match(pk.json.next, /核实/, 'the readable round is what the manager must check next');
});

test('omh packet: verify --only over every check is not partial', () => {
  const p = project();
  const id = p.ticket('pkonlyall');
  editTicket(p, id, (t) => t.replace(/(## 验收\n1\. `node add\.test\.js`[^\n]*\n)/, (m) => `${m}2. \`node add.test.js --second\` → 第二条\n`));
  assert.equal(p.run('dispatch', id).status, 0);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);

  const v = p.run('verify', id, '--only', '1,2');
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(v.json.checks.length, 2);
  assert.equal(v.json.partial, undefined, 'every check ran: nothing is partial');

  const saved = JSON.parse(fs.readFileSync(path.join(p.dir, '_receipts', `${id}.verify.json`), 'utf8'));
  assert.equal(saved.partial, undefined, 'the saved evidence agrees');

  const pk = p.run('packet', id);
  assert.equal(pk.status, 0, pk.stderr);
  assert.equal(pk.json.verify.partial, undefined);
  assert.equal(pk.json.verify.pass, true);
  assert.match(pk.json.next, /omh review/);
});

// ---------------------------------------------------------------- stage 3: scope code index

test('code index: symbols, line numbers and scope from the ticket patterns', async () => {
  const { indexFiles, renderIndex } = await import('../src/codeindex.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-index-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), [
    'export const LIMIT = 3;',
    'export function alpha(x) {',
    '  return x;',
    '}',
    '',
    'export class Beta {',
    '  run(a, b) {',
    '    return a;',
    '  }',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'b.py'), 'class Thing:\n    def go(self):\n        pass\n');
  fs.writeFileSync(path.join(dir, 'c.go'), 'package main\n\ntype Item struct {\n\tname string\n}\n\nfunc (i Item) Name() string {\n\treturn i.name\n}\n\nfunc main() {\n}\n');
  fs.writeFileSync(path.join(dir, 'd.md'), '# title\n\ntext\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'export function buried() {}\n');

  const entries = indexFiles(dir, ['**/*.js', 'src/a.js', '*.py', '*.go', '*.md']);
  assert.deepEqual(entries.map((e) => e.file), ['b.py', 'c.go', 'd.md', 'src/a.js'], 'sorted, deduplicated, node_modules skipped');

  const js = entries.find((e) => e.file === 'src/a.js');
  assert.equal(js.lines, 10);
  assert.deepEqual(js.symbols.map((s) => `${s.line} ${s.kind} ${s.name}`), ['1 const LIMIT', '2 function alpha', '6 class Beta', '7 method run']);

  const py = entries.find((e) => e.file === 'b.py');
  assert.deepEqual(py.symbols.map((s) => `${s.kind} ${s.name}`), ['class Thing', 'def go']);
  const go = entries.find((e) => e.file === 'c.go');
  assert.deepEqual(go.symbols.map((s) => `${s.kind} ${s.name}`), ['type Item', 'func Name', 'func main']);
  const md = entries.find((e) => e.file === 'd.md');
  assert.deepEqual(md.symbols, [], 'other text files: line count only');
  assert.equal(md.lines, 3);

  assert.deepEqual(indexFiles(dir, ['nope/**']), [], 'no matching files is not an error');

  const rendered = renderIndex(entries);
  assert.match(rendered, /## src\/a\.js（10 行）/);
  assert.match(rendered, /- 2 function alpha/);

  // the size cap: 20000 characters, cut and said so
  const many = Array.from({ length: 40 }, (_, i) => ({ file: `f${i}.js`, lines: 900, symbols: Array.from({ length: 80 }, (_, k) => ({ kind: 'function', name: `fn${k}`, line: k + 1 })) }));
  const big = renderIndex(many);
  assert.ok(big.length <= 20000, `index is ${big.length} chars`);
  assert.match(big, /截断/);
});

test('code index skips protected start dirs and oversized files', async () => {
  const { indexFiles, renderIndex, MAX_FILE_BYTES } = await import('../src/codeindex.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omh-index-guard-'));
  fs.mkdirSync(path.join(dir, '_tickets'));
  fs.writeFileSync(path.join(dir, '_tickets', 't.js'), 'export function secret() {}\n');
  assert.deepEqual(indexFiles(dir, ['_tickets/**']), [], 'a pattern aimed at a protected dir yields nothing');
  assert.deepEqual(indexFiles(dir, ['_tickets/t.js']), [], 'and neither does a literal path inside it');

  fs.writeFileSync(path.join(dir, 'big.js'), 'x'.repeat(MAX_FILE_BYTES + 1));
  const big = indexFiles(dir, ['big.js'])[0];
  assert.equal(big.skipped, 'too large');
  assert.equal(big.lines, null);
  assert.deepEqual(big.symbols, []);
  assert.match(renderIndex([big]), /过大，未索引/);
});

test('dispatch writes the scope code index and tells the worker to read it first', () => {
  const p = project();
  fs.writeFileSync(path.join(p.dir, 'add.js'), 'export function existing() {\n  return 1;\n}\n');
  const id = p.ticket('index');
  const d = p.run('dispatch', id);
  assert.equal(d.status, 0, d.stderr);

  const idx = path.join(p.dir, '_receipts', `${id}.index.md`);
  assert.ok(fs.existsSync(idx), 'index written next to the receipts');
  const md = fs.readFileSync(idx, 'utf8');
  assert.match(md, /## add\.js（3 行）/);
  assert.match(md, /- 1 function existing/);
  assert.doesNotMatch(md, /add\.test\.js/, 'only files that already exist are indexed');

  const spec = JSON.parse(fs.readFileSync(path.join(p.dir, '.omh', 'jobs', `${id}.build.spec.json`), 'utf8'));
  const prompt = spec.cmd.args[spec.cmd.args.length - 1];
  assert.ok(prompt.includes(idx), `prompt must name the index path: ${prompt.slice(0, 200)}`);
  assert.match(prompt, /先读范围代码索引/);
  assert.ok(!prompt.includes('\n'), 'prompt stays one line');

  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
});

test('no index when none of the ticket files exist yet, or when codeIndex is false', () => {
  const p = project();
  const fresh = p.ticket('fresh');
  assert.equal(p.run('dispatch', fresh).status, 0);
  assert.ok(!fs.existsSync(path.join(p.dir, '_receipts', `${fresh}.index.md`)), 'new-file ticket: no index');
  const spec0 = JSON.parse(fs.readFileSync(path.join(p.dir, '.omh', 'jobs', `${fresh}.build.spec.json`), 'utf8'));
  assert.doesNotMatch(spec0.cmd.args[spec0.cmd.args.length - 1], /范围代码索引/);
  assert.equal(p.run('wait', fresh, '--timeout-min', '1').status, 0);

  const q = project();
  fs.writeFileSync(path.join(q.dir, 'add.js'), 'export function existing() {}\n');
  setCfg(q, (c) => { c.codeIndex = false; });
  const off = q.ticket('off');
  assert.equal(q.run('dispatch', off).status, 0);
  assert.ok(!fs.existsSync(path.join(q.dir, '_receipts', `${off}.index.md`)), 'codeIndex: false → no index');
  const spec1 = JSON.parse(fs.readFileSync(path.join(q.dir, '.omh', 'jobs', `${off}.build.spec.json`), 'utf8'));
  assert.doesNotMatch(spec1.cmd.args[spec1.cmd.args.length - 1], /范围代码索引/);
  assert.equal(q.run('wait', off, '--timeout-min', '1').status, 0);
});

test('code index in a worktree ticket is built from the worktree', () => {
  const p = project();
  fs.writeFileSync(path.join(p.dir, 'add.js'), 'export function inMain() {\n  return 2;\n}\n');
  assert.equal(spawnSync('git', ['add', 'add.js'], { cwd: p.dir, env: p.env }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: p.dir, env: p.env }).status, 0);
  // The main repo drifts after the seed; only the worktree has the committed symbol, so
  // an index that reads the main repo cannot pass this.
  fs.writeFileSync(path.join(p.dir, 'add.js'), 'export function inMainDirty() {\n  return 99;\n}\n');
  const id = p.ticket('wtidx', 'worktree: true');
  const d = p.run('dispatch', id);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.json.workdir.replace(/\\/g, '/'), new RegExp(`\\.omh/worktrees/${id}$`));
  const md = fs.readFileSync(path.join(p.dir, '_receipts', `${id}.index.md`), 'utf8');
  assert.match(md, /## add\.js（3 行）/);
  assert.match(md, /- 1 function inMain\n/);
  assert.doesNotMatch(md, /inMainDirty/, 'the uncommitted main-repo version must not leak in');
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
});

test('code index follows the ticket base, not the workdir, when the ticket has workdir', () => {
  const p = project();
  fs.mkdirSync(path.join(p.dir, 'sub'));
  fs.writeFileSync(path.join(p.dir, 'sub', 'x.js'), 'export function nested() {\n  return 3;\n}\n');
  const id = p.ticket('nested', 'workdir: sub');
  const tp = path.join(p.dir, '_tickets', 'open', `${id}-nested.md`);
  fs.writeFileSync(tp, fs.readFileSync(tp, 'utf8').replace(/^files:.*$/m, 'files: [sub/x.js]'));
  const d = p.run('dispatch', id);
  assert.equal(d.status, 0, d.stderr);
  const md = fs.readFileSync(path.join(p.dir, '_receipts', `${id}.index.md`), 'utf8');
  assert.match(md, /## sub\/x\.js（3 行）/);
  assert.match(md, /- 1 function nested/);
  assert.equal(p.run('wait', id, '--timeout-min', '1').status, 0);
});

// ---------------------------------------------------------------- stage 4: acceptance profile advice

test('recommendChecks: config order, one copy of each command, unmatched files, fallback', () => {
  const cfg = {
    acceptanceProfiles: [
      { id: 'src', match: ['src/**'], commands: [{ purpose: 'unit', cmd: 'npm test' }, { purpose: 'lint', cmd: 'npm run lint' }] },
      { id: 'docs', match: ['docs/**'], commands: [{ purpose: 'unit', cmd: 'npm test' }, { purpose: 'links', cmd: 'node check-links.js' }] },
    ],
  };
  const r = recommendChecks(cfg, ['docs/x.md', 'src/a.js', 'README.md'], null);
  assert.deepEqual(r.matched, ['src', 'docs'], 'config order, not the order the diff listed files');
  assert.deepEqual(r.commands.map((c) => c.cmd), ['npm test', 'npm run lint', 'node check-links.js'], 'each command once');
  assert.deepEqual(r.unmatchedFiles, ['README.md']);
  assert.equal(r.fallback, null);

  const none = recommendChecks(cfg, ['README.md'], { body: '# T\n\n## 验收\n1. `node x.test.js` → ok\n' });
  assert.deepEqual(none.matched, []);
  assert.deepEqual(none.commands, []);
  assert.equal(none.fallback.message, NO_MATCH);
  assert.deepEqual(none.fallback.commands, ['node x.test.js'], 'falls back to the ticket, not to everything');
});

test('omh checks: matches the files git says changed, and only prints', () => {
  const p = project();
  const id = p.ticket('chk');
  fs.writeFileSync(path.join(p.dir, 'add.js'), 'export const add = (a, b) => a + b;\n');
  setCfg(p, (c) => {
    c.acceptanceProfiles = [{ id: 'js', title: 'js', match: ['*.js'], commands: [{ purpose: 'unit', cmd: 'node add.test.js' }] }];
  });
  const r = p.run('checks', id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.source, 'git');
  assert.deepEqual(r.json.matched, ['js']);
  assert.deepEqual(r.json.commands, [{ profile: 'js', purpose: 'unit', cmd: 'node add.test.js' }]);
  assert.deepEqual(r.json.unmatchedFiles, []);
});

test('omh checks: without git, uses the ticket files; no match says so and lists the ticket commands', () => {
  const p = project({ git: false });
  const id = p.ticket('nogit');
  setCfg(p, (c) => {
    c.acceptanceProfiles = [{ id: 'js', match: ['*.js'], commands: [{ purpose: 'unit', cmd: 'node add.test.js' }] }];
  });
  const r = p.run('checks', id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.source, 'ticket');
  assert.deepEqual(r.json.changedFiles, ['add.js', 'add.test.js', 'package.json']);
  assert.deepEqual(r.json.matched, ['js']);

  const q = project();
  const id2 = q.ticket('fresh');
  fs.writeFileSync(path.join(q.dir, 'notes.md'), 'x\n');
  const r2 = q.run('checks', id2);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(r2.json.matched, []);
  assert.deepEqual(r2.json.unmatchedFiles, ['notes.md']);
  assert.equal(r2.json.fallback.message, NO_MATCH);
  assert.deepEqual(r2.json.fallback.commands, ['node add.test.js']);
});

test('recommendChecks: broken profiles are skipped and reported, valid ones still match', () => {
  const cfg = {
    acceptanceProfiles: [
      { id: 'strmatch', match: 'src/**', commands: [{ purpose: 'unit', cmd: 'npm test' }] },
      { id: 'objcmds', match: ['src/**'], commands: {} },
      { id: 'core', match: ['src/**'], commands: [{ purpose: 'unit', cmd: 'npm test' }, { purpose: 'lint' }] },
    ],
  };
  const r = recommendChecks(cfg, ['src/a.js'], null);
  assert.deepEqual(r.invalidProfiles.map((p) => [p.index, p.id]), [[0, 'strmatch'], [1, 'objcmds']]);
  assert.ok(r.invalidProfiles.every((p) => typeof p.reason === 'string' && p.reason));
  assert.deepEqual(r.matched, ['core'], 'the valid profile still matches');
  assert.deepEqual(r.commands.map((c) => c.cmd), ['npm test'], 'an entry without a string cmd is skipped');
  assert.deepEqual(r.unmatchedFiles, []);
  assert.equal(r.fallback, null);
});

test('loadConfig: acceptanceProfiles defaults to an empty array', () => {
  const p = project();
  const saved = process.env.OMH_HOME;
  process.env.OMH_HOME = p.env.OMH_HOME;
  try {
    assert.deepEqual(loadConfig(p.dir).acceptanceProfiles, []);
  } finally {
    if (saved === undefined) delete process.env.OMH_HOME;
    else process.env.OMH_HOME = saved;
  }
});

test('omh checks: without git, says the ticket-files match is approximate', () => {
  const p = project({ git: false });
  const id = p.ticket('nogitnote');
  const r = p.run('checks', id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.source, 'ticket');
  assert.match(r.json.note, /近似匹配/);
  assert.match(r.json.note, /验收命令/);
  assert.deepEqual(r.json.invalidProfiles, []);
});

test('MCP server: omh_setup action checks returns source and matched', async () => {
  const p = project();
  const id = p.ticket('mcpchk');
  fs.writeFileSync(path.join(p.dir, 'add.js'), 'export const add = (a, b) => a + b;\n');
  setCfg(p, (c) => {
    c.acceptanceProfiles = [{ id: 'js', match: ['*.js'], commands: [{ purpose: 'unit', cmd: 'node add.test.js' }] }];
  });
  const child = spawn(process.execPath, [OMH, 'mcp'], { cwd: p.dir, env: p.env });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'omh_setup', arguments: { action: 'checks', ticket: id } } });
  const deadline = Date.now() + 5000;
  while (lines.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  const out = JSON.parse(byId[2].result.content[0].text);
  assert.equal(out.source, 'git');
  assert.deepEqual(out.matched, ['js']);
  assert.deepEqual(out.invalidProfiles, []);
});
