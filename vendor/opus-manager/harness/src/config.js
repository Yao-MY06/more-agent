// Config loading: built-in defaults ← ~/.omh/config.json ← <project>/.omh/config.json
import path from 'node:path';
import fs from 'node:fs';
import { readJson, deepMerge, homeDir, OmhError } from './util.js';

export const DEFAULTS = {
  lang: 'zh',
  shell: null,
  commitMessage: null,
  enabled: undefined, // master switch: true on / false off / unset manual
  paidAllowed: false,
  routingStrategy: 'quota-first',
  quotaPools: {},
  triage: {},
  acceptanceProfiles: [],
  launcher: null, // Windows: 'wmi' starts supervisors outside the caller's process tree
  maxParallel: 3,
  timeouts: { buildMin: 60, reviewMin: 30, idleWarnMin: 10, checkMin: 10 },
  budget: { totalUsd: null, perTicketUsd: null },
  limits: { provider: {} },
  maxAttempts: 2,
  review: { requireDifferentVendor: true, reviewers: [] },
  routing: { default: [] },
  workers: {},
  adapters: {},
};

export function findRoot(start = process.cwd()) {
  if (process.env.OMH_ROOT) return path.resolve(process.env.OMH_ROOT);
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.omh')) || fs.existsSync(path.join(dir, '_tickets'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

export function paths(root) {
  const t = path.join(root, '_tickets');
  const r = path.join(root, '_receipts');
  return {
    root,
    omh: path.join(root, '.omh'),
    config: path.join(root, '.omh', 'config.json'),
    jobs: path.join(root, '.omh', 'jobs'),
    worktrees: path.join(root, '.omh', 'worktrees'),
    cache: path.join(root, '.omh', 'cache.json'),
    tickets: t,
    receipts: r,
    events: path.join(r, 'events.jsonl'),
    progress: path.join(r, 'progress.md'),
    state: (s) => path.join(t, s),
  };
}

export function loadConfig(root) {
  const globalCfg = readJson(path.join(homeDir(), 'config.json'), {});
  const projectCfg = readJson(paths(root).config, {});
  const cfg = deepMerge(deepMerge(structuredClone(DEFAULTS), globalCfg), projectCfg);
  // workers can be declared globally and enabled per project; normalise ids
  for (const [id, w] of Object.entries(cfg.workers)) {
    w.id = id;
    w.roles = w.roles || ['build'];
    w.concurrency = w.concurrency ?? 1;
    w.consent = w.consent || {};
  }
  return cfg;
}

export function getWorker(cfg, id) {
  const w = cfg.workers[id];
  if (!w) throw new OmhError(`unknown worker "${id}". Configured: ${Object.keys(cfg.workers).join(', ') || '(none — run omh init / edit .omh/config.json)'}`, 'E_WORKER');
  return w;
}

export function sampleConfig(detected = []) {
  return {
    $comment: 'opus-harness project config. Workers need explicit user consent (codeAccess + autoApprove) before they can be dispatched.',
    lang: 'zh',
    maxParallel: 3,
    timeouts: { buildMin: 60, reviewMin: 30, idleWarnMin: 10, checkMin: 10 },
    budget: { totalUsd: null, perTicketUsd: null },
    limits: { provider: {} },
    review: { requireDifferentVendor: true, reviewers: [] },
    routing: { default: [] },
    workers: {},
    _detected: detected,
  };
}
