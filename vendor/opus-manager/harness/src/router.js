// Routing: which worker builds a ticket, which one reviews it.
//
// Builders: ticket.worker (pinned) > previous attempt's worker (never switch models
// mid-ticket) > routing[kind] chain > routing.default chain > any build-capable worker.
// The chain is a fallback list: the first worker that is installed, consented, under its
// concurrency/provider limits and under budget wins.
//
// Reviewers: config.review.reviewers order (or any review-capable worker), skipping the
// builder's vendor when requireDifferentVendor is on (cross-vendor review is the point).
import { getAdapter } from './adapters.js';
import { which } from './spawn.js';
import { runningJobs, spentUsd } from './jobs.js';
import { OmhError } from './util.js';
import { tierRank, paidProblem, quotaProblem, capabilityProblem } from './quota.js';

export function workerProblems(cfg, w, root, role) {
  const problems = [];
  if (!w.roles.includes(role)) problems.push(`not a ${role} worker`);
  let adapter;
  try {
    adapter = getAdapter(cfg, w.adapter);
  } catch (e) {
    problems.push(e.message);
    return problems;
  }
  if (role === 'review' && !adapter.review) problems.push(`adapter ${adapter.name} has no read-only review mode`);
  if (!which(adapter.bin)) problems.push(`${adapter.bin} not found on PATH`);
  if (!w.consent?.codeAccess) problems.push('user has not consented to this worker seeing the code (consent.codeAccess)');
  if (role === 'build' && !w.consent?.autoApprove) problems.push('user has not consented to unattended file edits (consent.autoApprove)');
  if (w.disabled) problems.push('disabled');
  const paid = paidProblem(cfg, w);
  if (paid) problems.push(paid);
  return problems;
}

function busyReason(cfg, w, root) {
  const running = runningJobs(root);
  if (running.length >= cfg.maxParallel) return `global maxParallel=${cfg.maxParallel} reached`;
  const mine = running.filter((j) => j.worker === w.id).length;
  if (mine >= w.concurrency) return `worker concurrency=${w.concurrency} reached`;
  if (w.provider && cfg.limits?.provider?.[w.provider] != null) {
    const prov = running.filter((j) => j.provider === w.provider).length;
    if (prov >= cfg.limits.provider[w.provider]) return `provider ${w.provider} limit=${cfg.limits.provider[w.provider]} reached`;
  }
  const q = quotaProblem(cfg, root, w);
  if (q) return q;
  if (w.budgetUsd != null) {
    const spent = spentUsd(root, (e) => e.worker === w.id);
    if (spent >= w.budgetUsd) return `worker budget $${w.budgetUsd} used ($${spent.toFixed(2)})`;
  }
  return null;
}

// Quota-first: within the candidates, free quota before subscriptions before unknown before
// paid; the configured chain order breaks ties. config.routingStrategy = "chain" keeps the
// chain order strictly.
function orderByQuota(cfg, chain) {
  if (cfg.routingStrategy === 'chain') return chain;
  return chain
    .map((id, i) => ({ id, i, r: cfg.workers[id] ? tierRank(cfg.workers[id]) : 99 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.id);
}

function pick(cfg, root, chain, role, ticket) {
  const tried = [];
  let anyBusy = false;
  for (const id of chain) {
    const w = cfg.workers[id];
    if (!w) {
      tried.push({ id, why: 'not configured' });
      continue;
    }
    const probs = workerProblems(cfg, w, root, role);
    if (role === 'build' && ticket) {
      const cap = capabilityProblem(w, ticket);
      if (cap) probs.push(cap);
    }
    if (probs.length) {
      tried.push({ id, why: probs.join('; ') });
      continue;
    }
    const busy = busyReason(cfg, w, root);
    if (busy) {
      if (!busy.startsWith('quota pool')) anyBusy = true; // used-up quota does not free itself
      tried.push({ id, why: busy });
      continue;
    }
    return { worker: w, tried };
  }
  return { worker: null, tried, busy: anyBusy };
}

export function pickBuilder(cfg, root, ticket, { override, previousWorker } = {}) {
  let chain;
  if (override) chain = [override];
  else if (ticket.fm.worker) chain = [String(ticket.fm.worker)];
  else if (previousWorker) chain = [previousWorker];
  else {
    const kind = ticket.fm.kind || 'default';
    chain = [...(cfg.routing?.[kind] || []), ...(cfg.routing?.default || [])];
    if (!chain.length) chain = Object.values(cfg.workers).filter((w) => w.roles.includes('build')).map((w) => w.id);
    chain = orderByQuota(cfg, [...new Set(chain)]);
  }
  const r = pick(cfg, root, chain, 'build', ticket);
  if (!r.worker) {
    const detail = r.tried.map((t) => `${t.id}: ${t.why}`).join(' | ') || 'no build workers configured';
    throw new OmhError(`no builder available for ${ticket.id} (${detail})`, r.busy ? 'E_BUSY' : 'E_NO_WORKER', { tried: r.tried });
  }
  return r;
}

export function pickReviewers(cfg, root, { builderVendor, override, count = 1 } = {}) {
  let chain = override ? [override] : cfg.review?.reviewers?.length ? cfg.review.reviewers : Object.values(cfg.workers).filter((w) => w.roles.includes('review')).map((w) => w.id);
  if (!override) chain = orderByQuota(cfg, chain);
  const chosen = [];
  const tried = [];
  const usedVendors = new Set();
  for (const id of chain) {
    if (chosen.length >= count) break;
    const w = cfg.workers[id];
    if (!w) {
      tried.push({ id, why: 'not configured' });
      continue;
    }
    if (!override && cfg.review?.requireDifferentVendor && builderVendor && w.vendor && w.vendor === builderVendor) {
      tried.push({ id, why: `same vendor as builder (${builderVendor})` });
      continue;
    }
    if (!override && count > 1 && w.vendor && usedVendors.has(w.vendor)) {
      tried.push({ id, why: 'vendor already reviewing' });
      continue;
    }
    const probs = workerProblems(cfg, w, root, 'review');
    if (probs.length) {
      tried.push({ id, why: probs.join('; ') });
      continue;
    }
    const busy = busyReason(cfg, w, root);
    if (busy) {
      tried.push({ id, why: busy });
      continue;
    }
    chosen.push(w);
    if (w.vendor) usedVendors.add(w.vendor);
  }
  if (!chosen.length) {
    const detail = tried.map((t) => `${t.id}: ${t.why}`).join(' | ') || 'no review workers configured';
    throw new OmhError(`no reviewer available (${detail})`, 'E_NO_WORKER', { tried });
  }
  return { reviewers: chosen, tried };
}
