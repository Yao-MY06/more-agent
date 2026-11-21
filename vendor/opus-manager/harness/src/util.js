// Small shared helpers. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const IS_WIN = process.platform === 'win32';

export function nowIso() {
  return new Date().toISOString();
}

export function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    // strip a UTF-8 BOM: Windows Notepad / PowerShell 5 often write one, and JSON.parse rejects it
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write via temp file + rename so readers never see a half-written file.
// On Windows a reader holding the file open can make rename fail with EPERM, so retry.
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      sleepSync(50);
    }
  }
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
}

export function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function tailText(text, maxLines = 40, maxChars = 4000) {
  if (!text) return '';
  let lines = text.split(/\r?\n/);
  let cut = false;
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    cut = true;
  }
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    cut = true;
  }
  return cut ? `…(truncated)\n${out}` : out;
}

export function readTail(file, maxBytes = 64 * 1024) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function humanDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function homeDir() {
  return process.env.OMH_HOME || path.join(os.homedir(), '.omh');
}

export function deepMerge(base, over) {
  if (over == null) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || base === null) {
    return over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Minimal glob → RegExp: supports **, *, ? and trailing "/" meaning "everything under".
export function globToRegExp(glob) {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => globToRegExp(g).test(f));
}

export class OmhError extends Error {
  constructor(message, code = 'E_OMH', extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
