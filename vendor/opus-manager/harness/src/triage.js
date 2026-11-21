// Dispatch gate. Deterministic: no model is consulted. It decides whether a ticket should
// go to a worker at all, conservatively, the way mainstream agents delegate sub-agents:
//   dispatch — scoped, decidable, worth it
//   keep     — the manager should do it (trivial, or a high-risk decision)
//   clarify  — not ready: acceptance, scope or goal is missing or vague
// The manager can override with --force and a reason; the override is recorded.
import { parseChecks, allowedFiles } from './tickets.js';
import { complexityOf, capabilityProblem } from './quota.js';

const DEFAULT_KEEP_KINDS = ['architecture', 'security', 'auth', 'permissions', 'secrets', 'data-migration', 'release', 'production', 'billing'];
const VAGUE = /(可能|也许|大概|看看|研究一下|优化一下|随便|之类|等等|待定|TBD|TODO|maybe|somehow|etc\.?$|something like|figure out)/i;

// A worker is a fresh process: it sees the ticket and the repo, never the conversation behind
// them. Neither of these can be answered from where it stands.
const PLACEHOLDER = /^\s*(?:\d+\.\s*|-\s*)?(<[^<>]+>)\s*$/m;
const DANGLING = /(上次|上回|之前那个|之前说|前面说|刚才|如前所述|同上|上文|照旧|老样子|as discussed|as before|last time|mentioned earlier|see above)/i;

// What the ticket says in its own words: not comments, and not code, where such words are data.
function prose(body) {
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function section(body, re) {
  const lines = body.split(/\r?\n/);
  const out = [];
  let on = false;
  for (const l of lines) {
    if (/^##\s/.test(l)) {
      on = re.test(l);
      continue;
    }
    if (on) out.push(l);
  }
  return out.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function triage(cfg, t) {
  const reasons = [];
  const facts = {};
  const tcfg = cfg.triage || {};
  const keepKinds = tcfg.keepKinds || DEFAULT_KEEP_KINDS;

  const checks = parseChecks(t.body).filter((c) => !/^<.*>$/.test(c.cmd));
  facts.checks = checks.length;
  const files = allowedFiles(t);
  facts.files = files ? files.length : 0;
  const goal = section(t.body, /^##\s*(目标|goal)/i);
  facts.goal = goal.slice(0, 160);
  const goalMissing = !goal || /^<.*>$/.test(goal.split('\n')[0].trim());
  const kind = String(t.fm.kind || 'default').toLowerCase();
  const risk = String(t.fm.risk || '').toLowerCase();
  const complexity = complexityOf(t.fm.complexity, 3);
  facts.kind = kind;
  facts.complexity = complexity;

  // keep: high-risk decisions stay with the manager
  if (keepKinds.includes(kind) || risk === 'high') {
    reasons.push(`high-risk work (${risk === 'high' ? 'risk: high' : `kind: ${kind}`}): the manager decides and does it, or splits off a scoped low-risk part`);
    return { ticket: t.id, decision: 'keep', reasons, facts };
  }
  // keep: trivial work costs more to delegate (ticket + verify) than to do
  if (complexity <= 1 || String(t.fm.size || '').toLowerCase() === 'trivial') {
    reasons.push('trivial (complexity 1): writing, dispatching and verifying a ticket costs more than doing it');
    return { ticket: t.id, decision: 'keep', reasons, facts };
  }
  // clarify: not decidable / not scoped / vague
  if (!checks.length) reasons.push('no acceptance commands (numbered, backticked, under "## 验收" / "## Acceptance"): nothing to verify independently');
  if (!files) reasons.push('no `files:` scope in the header: out-of-scope edits cannot be detected');
  if (goalMissing) reasons.push('goal is missing or still the template placeholder');
  else if (VAGUE.test(goal)) reasons.push(`goal is vague ("${goal.match(VAGUE)[0]}"): settle the requirement first`);
  const words = prose(t.body);
  const placeholder = words.match(PLACEHOLDER);
  if (placeholder && !goalMissing) reasons.push(`template placeholder left in the ticket (${placeholder[1]}): fill it in or delete it`);
  const dangling = words.match(DANGLING);
  if (dangling) reasons.push(`leans on context ("${dangling[0]}"): the worker only sees this ticket and the repo, so write out what is meant`);
  // no capable worker at all → keep it rather than hand it to a weaker model
  const builders = Object.values(cfg.workers || {}).filter((w) => (w.roles || ['build']).includes('build') && !w.disabled);
  if (builders.length && builders.every((w) => capabilityProblem(w, t))) {
    reasons.push(`no build worker is rated for complexity ${complexity} (maxComplexity): keep it, split it, or rate a worker`);
    return { ticket: t.id, decision: reasons.length > 1 ? 'clarify' : 'keep', reasons, facts };
  }
  if (reasons.length) return { ticket: t.id, decision: 'clarify', reasons, facts };
  return { ticket: t.id, decision: 'dispatch', reasons: ['scoped, decidable acceptance, not high-risk, not trivial'], facts };
}
