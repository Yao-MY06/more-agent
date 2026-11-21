// Scope code index: a compact symbol outline of the files a ticket names, so the worker can
// jump to the right line instead of reading whole files. Zero dependencies, regex only —
// it is a map, not a parser: wrong guesses cost a glance, not a wrong edit.
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from './util.js';

export const MAX_FILES = 50;
export const MAX_SYMBOLS = 80;
export const MAX_INDEX_CHARS = 20000;
// Dispatch is synchronous: a huge file or a huge tree must not stall it.
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_WALK_ENTRIES = 20000;

// Never index the harness's own bookkeeping or installed packages.
const SKIP_DIRS = new Set(['node_modules', '.git', '_tickets', '_receipts', '.omh']);
const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try', 'finally',
  'with', 'function', 'await', 'new', 'typeof', 'delete', 'void', 'yield',
]);

function jsSymbol(line) {
  let m;
  if ((m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
    return { kind: 'class', name: m[1] };
  }
  if ((m = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
    return { kind: 'function', name: m[1] };
  }
  if ((m = line.match(/^\s*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
    return { kind: m[1], name: m[2] };
  }
  // `name(...) {` — a method of a class or object literal, not a control statement
  if ((m = line.match(/^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/))) {
    if (!JS_KEYWORDS.has(m[1])) return { kind: 'method', name: m[1] };
  }
  return null;
}

function pySymbol(line) {
  let m;
  if ((m = line.match(/^\s*class\s+([A-Za-z_]\w*)\s*[:(]/))) return { kind: 'class', name: m[1] };
  if ((m = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/))) return { kind: 'def', name: m[1] };
  return null;
}

function goSymbol(line) {
  let m;
  if ((m = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([{]/))) return { kind: 'func', name: m[1] };
  if ((m = line.match(/^\s*type\s+([A-Za-z_]\w*)\s/))) return { kind: 'type', name: m[1] };
  return null;
}

function symbolsOf(file, text) {
  const ext = path.extname(file).toLowerCase();
  const pick = JS_EXT.has(ext) ? jsSymbol : ext === '.py' || ext === '.pyw' ? pySymbol : ext === '.go' ? goSymbol : null;
  if (!pick) return []; // other text files: line count only
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const s = pick(lines[i]);
    if (s) out.push({ kind: s.kind, name: s.name, line: i + 1 });
  }
  return out;
}

function lineCount(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function indexOne(baseDir, rel) {
  const abs = path.join(baseDir, rel);
  let size;
  try {
    size = fs.statSync(abs).size;
  } catch {
    return null;
  }
  // Too big to skim: say so, but do not read it.
  if (size > MAX_FILE_BYTES) return { file: rel, lines: null, symbols: [], skipped: 'too large' };
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (buf.includes(0)) return null; // binary: nothing a worker reads as text
  const text = buf.toString('utf8');
  return { file: rel, lines: lineCount(text), symbols: symbolsOf(rel, text) };
}

function inside(root, abs) {
  const r = path.relative(root, abs);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

// A pattern may name a protected directory directly (`_tickets/**`); expand sees that
// before walk does, so it has to skip it too.
function hitsSkipDir(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel) return false;
  return rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg));
}

function walk(root, dir, re, out, budget) {
  if (budget.used >= MAX_WALK_ENTRIES) return;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (budget.used >= MAX_WALK_ENTRIES) return;
    budget.used += 1;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(root, abs, re, out, budget);
    } else if (ent.isFile()) {
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (re.test(rel)) out.add(rel);
    }
  }
}

function expand(root, patterns) {
  const out = new Set();
  const budget = { used: 0 };
  for (const p of patterns) {
    if (budget.used >= MAX_WALK_ENTRIES) break;
    const pat = p.endsWith('/') ? `${p}**` : p;
    if (!/[*?]/.test(pat)) {
      const abs = path.resolve(root, pat);
      if (!inside(root, abs) || hitsSkipDir(root, abs)) continue;
      try {
        if (fs.statSync(abs).isFile()) out.add(path.relative(root, abs).replace(/\\/g, '/'));
      } catch {}
      continue;
    }
    const segs = pat.split('/');
    const cut = segs.findIndex((s) => /[*?]/.test(s));
    const start = path.resolve(root, segs.slice(0, cut).join('/'));
    if (!inside(root, start) || hitsSkipDir(root, start)) continue;
    walk(root, start, globToRegExp(pat), out, budget);
  }
  return [...out].sort();
}

function toPatterns(patterns) {
  const arr = Array.isArray(patterns) ? patterns : patterns == null ? [] : [patterns];
  return arr.map((p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
}

// Expand the ticket's `files:` patterns under baseDir and describe every file that exists.
export function indexFiles(baseDir, patterns) {
  const root = path.resolve(baseDir);
  const out = [];
  for (const rel of expand(root, toPatterns(patterns)).slice(0, MAX_FILES)) {
    const e = indexOne(root, rel);
    if (e) out.push(e);
  }
  return out;
}

const HEAD = '# 范围代码索引 Scope code index\n\n派单时自动生成：只列符号和行号，不是全文。先读它，再按需打开文件。\n';
const TRUNC = '\n…（已截断：索引超过 20000 字符，其余文件请直接在作业目录里查看）\n';

export function renderIndex(entries) {
  const room = MAX_INDEX_CHARS - TRUNC.length;
  let out = HEAD;
  let cut = false;
  for (const e of Array.isArray(entries) ? entries : []) {
    let sec = e.skipped ? `\n## ${e.file}（过大，未索引）\n` : `\n## ${e.file}（${e.lines} 行）\n`;
    if (e.skipped) sec += '- （文件超过 1MB，未读取内容）\n';
    else if (e.symbols?.length) for (const s of e.symbols) sec += `- ${s.line} ${s.kind} ${s.name}\n`;
    else sec += '- （没有提取到符号）\n';
    if (out.length + sec.length > room) {
      cut = true;
      break;
    }
    out += sec;
  }
  return cut ? out + TRUNC : out;
}
