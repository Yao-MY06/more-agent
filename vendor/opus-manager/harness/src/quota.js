// Quota tiers and the quota ledger. The point of the harness is to spend free quota first
// (platform credits, free-tier models, local models), subscriptions next, and pay-per-use
// last and only when explicitly allowed. Nothing here silently upgrades to a paid worker.
import { readEvents } from './jobs.js';

export const TIERS = ['free', 'subscription', 'unknown', 'paid'];

export function tierOf(w) {
  return TIERS.includes(w.quota) ? w.quota : 'unknown';
}

export function tierRank(w) {
  return TIERS.indexOf(tierOf(w));
}

// A paid worker runs only with explicit permission (worker.paidAllowed or config.paidAllowed).
export function paidProblem(cfg, w) {
  if (tierOf(w) !== 'paid') return null;
  if (w.paidAllowed === true || cfg.paidAllowed === true) return null;
  return 'paid worker: pay-per-use needs explicit permission (paidAllowed: true)';
}

// Complexity 1..5 (1 trivial, 3 normal, 5 hard). Words are accepted for readability.
const WORDS = { trivial: 1, low: 2, small: 2, medium: 3, normal: 3, high: 4, large: 4, hard: 5, max: 5 };
export function complexityOf(v, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v === 'number') return Math.max(1, Math.min(5, v));
  const n = Number(v);
  if (!Number.isNaN(n)) return Math.max(1, Math.min(5, n));
  return WORDS[String(v).toLowerCase()] ?? dflt;
}

export function capabilityProblem(w, ticket) {
  const need = complexityOf(ticket?.fm?.complexity, 3);
  const max = complexityOf(w.maxComplexity, 5);
  return need > max ? `ticket complexity ${need} exceeds this worker's maxComplexity ${max}` : null;
}

// ---- ledger ----------------------------------------------------------------

const PERIOD_MS = { day: 24 * 3600 * 1000, week: 7 * 24 * 3600 * 1000, month: 31 * 24 * 3600 * 1000 };

function periodStart(period, now = new Date()) {
  if (period === 'day') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (period === 'week') return now.getTime() - PERIOD_MS.week;
  return 0; // total
}

// Which pool a worker draws from: workers that share one platform account (e.g. several
// WorkBuddy models) set the same quotaPool; otherwise each worker is its own pool.
export function poolOf(w) {
  return w.quotaPool || w.id;
}

export function poolLimit(cfg, w) {
  return cfg.quotaPools?.[poolOf(w)] || w.quotaLimit || null;
}

function usageOf(e) {
  const u = e.usage || {};
  return {
    jobs: 1,
    credits: typeof u.credits === 'number' ? u.credits : 0,
    tokens: u.totalTokens || (u.inputTokens || 0) + (u.outputTokens || 0),
    costUsd: typeof u.costUsd === 'number' ? u.costUsd : 0,
  };
}

export function poolUsage(cfg, root, pool, period = 'total') {
  const members = new Set(Object.values(cfg.workers).filter((w) => poolOf(w) === pool).map((w) => w.id));
  const since = periodStart(period);
  const sum = { jobs: 0, credits: 0, tokens: 0, costUsd: 0 };
  for (const e of readEvents(root)) {
    if (e.type !== 'job-end' || !members.has(e.worker) || Date.parse(e.ts) < since) continue;
    const u = usageOf(e);
    for (const k of Object.keys(sum)) sum[k] += u[k];
  }
  sum.credits = Number(sum.credits.toFixed(4));
  sum.costUsd = Number(sum.costUsd.toFixed(4));
  return sum;
}

// null when the pool still has room; otherwise a one-line reason
export function quotaProblem(cfg, root, w) {
  const lim = poolLimit(cfg, w);
  if (!lim) return null;
  const used = poolUsage(cfg, root, poolOf(w), lim.period || 'total');
  for (const k of ['credits', 'tokens', 'jobs', 'costUsd']) {
    if (lim[k] != null && used[k] >= lim[k]) {
      return `quota pool "${poolOf(w)}" used ${used[k]} of ${lim[k]} ${k} this ${lim.period || 'total'}`;
    }
  }
  return null;
}

export function quotaReport(cfg, root) {
  const pools = {};
  for (const w of Object.values(cfg.workers)) {
    const pool = poolOf(w);
    const lim = poolLimit(cfg, w);
    const p = (pools[pool] ||= { workers: [], tier: tierOf(w), limit: lim, period: lim?.period || 'total' });
    p.workers.push(w.id);
    if (tierRank(w) > TIERS.indexOf(p.tier)) p.tier = tierOf(w);
  }
  for (const [pool, p] of Object.entries(pools)) {
    p.used = poolUsage(cfg, root, pool, p.period);
    if (p.limit) {
      p.remaining = {};
      for (const k of ['credits', 'tokens', 'jobs', 'costUsd']) if (p.limit[k] != null) p.remaining[k] = Number((p.limit[k] - p.used[k]).toFixed(4));
      p.exhausted = Object.values(p.remaining).some((v) => v <= 0);
    }
  }
  return {
    order: 'free → subscription → unknown → paid (paid only with paidAllowed)',
    pools,
    note: 'Usage counts what each tool reports; tools that report nothing count only jobs. Unknown is never shown as free.',
  };
}
