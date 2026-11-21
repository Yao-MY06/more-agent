// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no SDK dependency.
// Exposes a deliberately small tool set: every tool schema costs the manager context,
// so rarely used operations are folded into one `omh_setup` tool.
import readline from 'node:readline';
import { findRoot } from './config.js';
import * as core from './core.js';
import { packet } from './packet.js';

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d });
const TOOLS = [
  {
    name: 'omh_status',
    description: 'Harness overview: running jobs (with quiet time), recent results, ready and blocked tickets, spend vs budget. Cheap; call it instead of reading files.',
    inputSchema: S({}),
    run: (root) => core.status(root),
  },
  {
    name: 'omh_next',
    description: 'Open tickets with readiness (dependencies) and the worker routing would pick for each.',
    inputSchema: S({}),
    run: (root) => core.next(root),
  },
  {
    name: 'omh_new',
    description: 'Create a ticket skeleton in _tickets/open/ from the template and return its path. Then edit the file (goal, boundaries, backticked acceptance commands) before dispatching.',
    inputSchema: S({
      slug: str('short kebab name'),
      title: str('one-line title'),
      kind: str('routing category, e.g. backend, frontend, docs-zh (see config.routing)'),
      depends: { type: 'array', items: { type: 'string' }, description: 'ticket ids that must be done first' },
      files: { type: 'array', items: { type: 'string' }, description: 'paths/globs the worker may change; enforced by omh_verify' },
      workdir: str('workdir relative to project root'),
      worker: str('pin a worker id'),
    }, ['slug']),
    run: (root, a) => core.newTicket(root, a),
  },
  {
    name: 'omh_dispatch',
    description: 'Claim a ticket (open→doing), sign it, and start the routed worker detached. Returns immediately; follow with omh_wait or `omh wait <T>` as a background shell command.',
    inputSchema: S({ ticket: str('ticket id, e.g. T12'), worker: str('override routing'), retry: { type: 'boolean', description: 're-run a ticket already in doing/ or blocked/ (same worker unless overridden)' }, force: { type: 'boolean', description: 'override a triage refusal or the off switch (needs reason)' }, reason: str('why the override is justified') }, ['ticket']),
    run: (root, a) => core.dispatch(root, a.ticket, a),
  },
  {
    name: 'omh_review',
    description: 'Start read-only review(s) of a built ticket by worker(s) from a different vendor than the builder. Report lands in _receipts/<T>.review-N.md.',
    inputSchema: S({ ticket: str('ticket id'), reviewer: str('force a reviewer'), count: { type: 'integer', minimum: 1, maximum: 3, description: 'parallel reviewers from distinct vendors' } }, ['ticket']),
    run: (root, a) => core.review(root, a.ticket, a),
  },
  {
    name: 'omh_wait',
    description: 'Block until the given tickets\' jobs end (or timeout_sec, max 600). For long jobs prefer the shell: `omh wait T12 --timeout-min 55` in the background.',
    inputSchema: S({ tickets: { type: 'array', items: { type: 'string' } }, phase: str('build | review | review-N'), timeout_sec: { type: 'integer', minimum: 1, maximum: 600 } }),
    run: (root, a) => core.wait(root, a.tickets || [], { phase: a.phase, timeoutSec: Math.min(a.timeout_sec || 240, 600) }),
  },
  {
    name: 'omh_verify',
    description: 'Manager-side evidence: re-run the ticket\'s backticked acceptance commands in its workdir and check changed files against its `files:` scope. Outputs are tailed; full log path returned.',
    inputSchema: S({ ticket: str('ticket id'), only: str('comma list of check numbers') }, ['ticket']),
    run: (root, a) => core.verify(root, a.ticket, a),
  },
  {
    name: 'omh_packet',
    description: 'One compact hand-off for accepting a ticket: state, actual changed files, per-check verify results, out-of-scope files, the worker\'s claimed commands vs. the independent evidence, review findings by severity, and the next step. Call this before accepting, instead of reading the receipt, diff and logs one by one.',
    inputSchema: S({ ticket: str('ticket id') }, ['ticket']),
    run: (root, a) => packet(root, a.ticket),
  },
  {
    name: 'omh_move',
    description: 'Move a ticket: done (accept; optional git commit; appends progress.md), blocked/dropped (with reason), open.',
    inputSchema: S({ ticket: str('ticket id'), to: { type: 'string', enum: ['open', 'doing', 'done', 'blocked', 'dropped'] }, reason: str('why (blocked/dropped)'), commit: { type: 'boolean' }, reset: { type: 'boolean', description: 'with to=open: zero the failure count (a deliberate decision)' } }, ['ticket', 'to']),
    run: (root, a) => core.move(root, a.ticket, a.to, a),
  },
  {
    name: 'omh_log',
    description: 'Tail a job log (build or review-N).',
    inputSchema: S({ ticket: str('ticket id'), phase: str('build | review-N'), lines: { type: 'integer', minimum: 5, maximum: 400 } }, ['ticket']),
    run: (root, a) => core.log(root, a.ticket, a),
  },
  {
    name: 'omh_setup',
    description: 'Setup and bookkeeping: action=switch (master switch status; call at the start of a task) | triage (needs ticket: dispatch/keep/clarify) | quota | init | detect | probe (needs adapter) | workers | cost | kill (needs ticket, optional phase) | checks (needs ticket: which acceptance profile fits the changed files; advice only).',
    inputSchema: S({ action: { type: 'string', enum: ['switch', 'triage', 'quota', 'init', 'detect', 'probe', 'workers', 'cost', 'kill', 'checks'] }, adapter: str('for probe'), ticket: str('for kill / triage / checks'), phase: str('for kill') }, ['action']),
    run: (root, a) => {
      switch (a.action) {
        case 'switch': return core.switchStatus(root);
        case 'triage': return core.triage(root, a.ticket);
        case 'quota': return core.quota(root);
        case 'init': return core.init(root);
        case 'detect': return core.detect(root);
        case 'probe': return core.probe(root, a.adapter);
        case 'workers': return core.workers(root);
        case 'cost': return core.cost(root);
        case 'kill': return core.kill(root, a.ticket, { phase: a.phase || 'build' });
        case 'checks': return core.checks(root, a.ticket);
        default: throw new Error(`unknown action ${a.action}`);
      }
    },
  },
];

export async function serve() {
  const root = findRoot(process.cwd());
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const { id, method, params } = req;
    const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        reply({
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'opus-harness', version: core.VERSION },
          instructions: `opus-manager harness for project ${root}. You are the manager: write tickets, dispatch to workers, verify with omh_verify, get cross-vendor reviews, check each finding yourself.`,
        });
      } else if (method === 'ping') reply({});
      else if (method === 'tools/list') reply({ tools: TOOLS.map(({ run, ...t }) => t) });
      else if (method === 'tools/call') {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `unknown tool ${params?.name}`);
        try {
          const out = await tool.run(root, params.arguments || {});
          reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
        } catch (e) {
          reply({ content: [{ type: 'text', text: JSON.stringify({ error: e.code || 'E', message: e.message }) }], isError: true });
        }
      } else if (method?.startsWith('notifications/')) {
        /* ignore */
      } else fail(-32601, `method not found: ${method}`);
    } catch (e) {
      fail(-32603, String(e.message || e));
    }
  });
  await new Promise((resolve) => rl.on('close', resolve));
}
