// Acceptance-profile advice: which of the config's `acceptanceProfiles` fit what actually
// changed, and the smallest set of commands that follows. This module only computes text;
// neither it nor `omh checks` ever runs a command — executing and judging stays with the manager.
import { matchesAny } from './util.js';
import { parseChecks } from './tickets.js';

export const NO_MATCH = '没有匹配的档案：用工单自己的验收命令';

// `acceptanceProfiles` is hand-written config, so each entry is checked before use: a broken
// profile is skipped and reported, never allowed to throw or to look like "no match".
function profileProblem(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '档案不是对象';
  if (typeof p.id !== 'string') return 'id 不是字符串';
  if (!Array.isArray(p.match) || !p.match.every((g) => typeof g === 'string')) return 'match 不是字符串数组';
  if (!Array.isArray(p.commands)) return 'commands 不是数组';
  return null;
}

export function recommendChecks(cfg, changedFiles, ticket) {
  const raw = Array.isArray(cfg?.acceptanceProfiles) ? cfg.acceptanceProfiles : [];
  const profiles = [];
  const invalidProfiles = [];
  raw.forEach((p, index) => {
    const reason = profileProblem(p);
    if (reason) invalidProfiles.push({ index, id: typeof p?.id === 'string' ? p.id : null, reason });
    else profiles.push(p);
  });
  const files = (changedFiles || []).map((f) => String(f));
  const hits = new Set();
  const unmatchedFiles = [];
  for (const f of files) {
    const fitting = profiles.filter((p) => matchesAny(f, p.match));
    if (!fitting.length) unmatchedFiles.push(f);
    for (const p of fitting) hits.add(p.id);
  }
  // Report profiles in config order, not in the order the diff happened to list files,
  // so the same change always produces the same advice.
  const matched = profiles.filter((p) => hits.has(p.id)).map((p) => p.id);
  const commands = [];
  const seen = new Set();
  for (const p of profiles) {
    if (!hits.has(p.id)) continue;
    for (const c of p.commands) {
      if (typeof c?.cmd !== 'string' || !c.cmd || seen.has(c.cmd)) continue;
      seen.add(c.cmd);
      commands.push({ profile: p.id, purpose: typeof c.purpose === 'string' ? c.purpose : '', cmd: c.cmd });
    }
  }
  // Nothing matched: say so and hand back the ticket's own acceptance commands, rather
  // than quietly recommending a full regression.
  const fallback = matched.length
    ? null
    : { message: NO_MATCH, commands: ticket ? parseChecks(ticket.body || '').map((c) => c.cmd) : [] };
  return { matched, commands, unmatchedFiles, invalidProfiles, fallback };
}
