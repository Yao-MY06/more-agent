// Thin git helpers (git is optional: projects without git still work, with less checking).
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { runSync } from './spawn.js';
import { OmhError } from './util.js';

// harness bookkeeping never counts as "the change"
const EXCLUDE = ['--', '.', ':(exclude)_tickets', ':(exclude)_receipts', ':(exclude).omh'];
// Each one is an argument, and Windows caps a command line at about 32k characters. Past this
// a diff stays whole: noise is better than a failed git command and an empty diff.
const MAX_DIFF_EXCLUDES = 100;

export function git(cwd, args, opts = {}) {
  return runSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, timeoutMs: opts.timeoutMs || 30000 });
}

export function isGitRepo(cwd) {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

export function headSha(cwd) {
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout.trim() : null;
}

// Files changed in the working tree relative to `base` (default HEAD), plus untracked files.
// Paths are relative to the repo top-level, forward slashes.
export function changedFiles(cwd, base) {
  const files = new Set();
  const diff = git(cwd, ['diff', '--name-only', base || 'HEAD', ...EXCLUDE]);
  if (diff.ok) diff.stdout.split(/\r?\n/).filter(Boolean).forEach((f) => files.add(f));
  const untracked = git(cwd, ['ls-files', '--full-name', '--others', '--exclude-standard', ...EXCLUDE]);
  if (untracked.ok) untracked.stdout.split(/\r?\n/).filter(Boolean).forEach((f) => files.add(f));
  return [...files];
}

function fileHash(full) {
  try {
    return createHash('sha1').update(fs.readFileSync(full)).digest('hex');
  } catch {
    return null; // gone, or not a regular file
  }
}

// What is uncommitted right now, as {repo-relative path: content hash}. Taken before a worker
// starts, so that work already lying around is not mistaken for what the worker did.
export function takeBaseline(cwd, base) {
  const top = repoTop(cwd);
  return Object.fromEntries(changedFiles(cwd, base).map((f) => [f, fileHash(path.join(top, f))]));
}

export function unchangedSince(cwd, baseline) {
  const top = repoTop(cwd);
  return Object.keys(baseline).filter((f) => fileHash(path.join(top, f)) === baseline[f]);
}

// Files changed since the baseline. Every baseline file that is not identical counts, which also
// catches a deleted untracked file: changedFiles cannot see that one, git no longer lists it.
export function changedSince(cwd, base, baseline) {
  const same = new Set(unchangedSince(cwd, baseline));
  return [...new Set([...changedFiles(cwd, base), ...Object.keys(baseline)])].filter((f) => !same.has(f));
}

export function repoTop(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? path.resolve(r.stdout.trim()) : null;
}

// leaveOut: repo-relative paths that are not part of this change.
export function diffText(cwd, base, leaveOut = []) {
  const parts = [];
  const skip = new Set(leaveOut);
  const top = repoTop(cwd);
  const excludes = leaveOut.length <= MAX_DIFF_EXCLUDES ? leaveOut.map((f) => `:(top,exclude,literal)${f}`) : [];
  const d = git(cwd, ['diff', base || 'HEAD', ...EXCLUDE, ...excludes], { timeoutMs: 60000 });
  if (d.ok) parts.push(d.stdout);
  const u = git(cwd, ['ls-files', '--others', '--exclude-standard', ...EXCLUDE]);
  if (u.ok) {
    for (const f of u.stdout.split(/\r?\n/).filter(Boolean)) {
      const full = path.join(cwd, f);
      if (top && skip.has(path.relative(top, full).replace(/\\/g, '/'))) continue;
      let content = '';
      try {
        const st = fs.statSync(full);
        content = st.size > 200 * 1024 ? '(large file, not inlined)' : fs.readFileSync(full, 'utf8');
      } catch {}
      parts.push(`--- /dev/null\n+++ b/${f}  (new, untracked)\n${content.split('\n').map((l) => '+' + l).join('\n')}\n`);
    }
  }
  return parts.join('\n');
}

export function addWorktree(repoCwd, dir, branch, base) {
  const r = git(repoCwd, ['worktree', 'add', '-b', branch, dir, base || 'HEAD'], { timeoutMs: 120000 });
  if (!r.ok) throw new OmhError(`git worktree add failed: ${r.stderr.trim()}`, 'E_GIT');
}

// pathspecs: null → everything (git add -A); otherwise only these paths are staged and committed.
export function commitAll(cwd, message, pathspecs = null) {
  const a = git(cwd, pathspecs ? ['add', '-A', '--', ...pathspecs] : ['add', '-A']);
  if (!a.ok) throw new OmhError(`git add failed: ${a.stderr.trim()}`, 'E_GIT');
  const c = git(cwd, pathspecs ? ['commit', '-m', message, '--', ...pathspecs] : ['commit', '-m', message]);
  if (!c.ok && !/nothing to commit/.test(c.stdout + c.stderr)) throw new OmhError(`git commit failed: ${(c.stderr || c.stdout).trim()}`, 'E_GIT');
  return headSha(cwd);
}
