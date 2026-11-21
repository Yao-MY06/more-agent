// Cross-platform command resolution, spawning and process-tree killing.
//
// Windows is the hard part: most AI CLIs are installed by npm as `.cmd` shims, and
// Node refuses to spawn `.cmd` files without a shell. Going through cmd.exe mangles
// prompts that contain quotes, `%`, `&`, `|` or non-ASCII text. So we:
//   1. resolve the command on PATH ourselves (honouring PATHEXT),
//   2. if it is an npm shim, read the shim and run `node <script.js>` directly,
//   3. only as a last resort go through cmd.exe with cross-spawn style escaping.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { IS_WIN } from './util.js';

export function which(cmd, env = process.env) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || (IS_WIN && cmd.includes('\\'))) {
    return fs.existsSync(cmd) ? path.resolve(cmd) : null;
  }
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (IS_WIN) {
          // On Windows an extension-less file (e.g. a bash script npm also drops) is not runnable.
          if (!ext && !/\.(exe|com|cmd|bat)$/i.test(full)) continue;
        } else {
          try { fs.accessSync(full, fs.constants.X_OK); } catch { continue; }
        }
        return full;
      } catch {}
    }
  }
  return null;
}

// Parse an npm cmd-shim and return the JS entry it would run, if any.
export function parseNpmShim(cmdPath) {
  let text;
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/"%~?dp0%?\\([^"]+?)"\s*%\*/i);
  if (!m) return null;
  const target = path.join(path.dirname(cmdPath), ...m[1].split(/[\\/]+/));
  if (!fs.existsSync(target)) return null;
  return target;
}

function escapeMeta(s) {
  return s.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
}
function escapeArg(arg, doubleEscape) {
  let a = String(arg).replace(/[\r\n]+/g, ' ');
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`;
  a = escapeMeta(a);
  if (doubleEscape) a = escapeMeta(a);
  return a;
}

// Returns { file, args, windowsVerbatimArguments, resolved, via } or null if not found.
export function resolveInvocation(bin, args = [], env = process.env) {
  const resolved = which(bin, env);
  if (!resolved) return null;
  if (!IS_WIN) return { file: resolved, args, resolved, via: 'direct' };
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: resolved, args, resolved, via: 'direct' };
  if (ext === '.cmd' || ext === '.bat') {
    const target = parseNpmShim(resolved);
    if (target) {
      const t = path.extname(target).toLowerCase();
      if (t === '.exe') return { file: target, args, resolved, via: 'shim-exe' };
      if (['.js', '.mjs', '.cjs', ''].includes(t)) {
        const localNode = path.join(path.dirname(resolved), 'node.exe');
        const node = fs.existsSync(localNode) ? localNode : process.execPath;
        return { file: node, args: [target, ...args], resolved, via: 'shim-node' };
      }
    }
    const line = [escapeMeta(resolved), ...args.map((a) => escapeArg(a, true))].join(' ');
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
      resolved,
      via: 'cmd',
    };
  }
  return { file: resolved, args, resolved, via: 'direct' };
}

// Run a short command synchronously (for --help / --version / git).
export function runSync(bin, args, { cwd, timeoutMs = 20000, env = process.env, input } = {}) {
  const inv = resolveInvocation(bin, args, env);
  if (!inv) return { ok: false, notFound: true, status: null, stdout: '', stderr: `${bin}: not found on PATH` };
  const r = spawnSync(inv.file, inv.args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    signal: r.signal,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error.message) : ''),
    error: r.error,
  };
}

// Which shell runs acceptance checks. Claude Code on Windows runs its Bash tool in Git Bash,
// so tickets it writes use bash syntax; prefer Git Bash there (never WSL's System32 bash).
export function checkShell(env = process.env, configured) {
  if (configured) return configured;
  if (env.OMH_SHELL) return env.OMH_SHELL;
  if (!IS_WIN) return env.SHELL && /bash|zsh|sh$/.test(env.SHELL) ? env.SHELL : '/bin/sh';
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  const gitExe = which('git', env);
  if (gitExe) candidates.push(path.join(path.dirname(gitExe), '..', 'bin', 'bash.exe'));
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  return env.ComSpec || 'cmd.exe';
}

// Run a shell command line (used for acceptance checks written by the manager).
export function runShellSync(line, { cwd, timeoutMs = 10 * 60 * 1000, env = process.env, shell } = {}) {
  const r = spawnSync(line, {
    cwd,
    env,
    shell: checkShell(env, shell),
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: r.status,
    signal: r.signal,
    timedOut: r.error?.code === 'ETIMEDOUT',
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error.message) : ''),
  };
}

// PowerShell single-quoted literal
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Command that starts `node script args` through WMI (Win32_Process.Create). The process is
// created by the WMI service, outside the caller's process tree and job object, so closing the
// terminal / agent session that ran `omh dispatch` cannot take it down. It runs with the
// user's default environment, not the caller's.
export function wmiLaunchCommand(script, args, cwd) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const line = [q(process.execPath), q(script), ...args.map(q)].join(' ');
  return `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psq(line)}; CurrentDirectory = ${psq(cwd)} }; if ($r.ReturnValue -ne 0) { exit 1 }; $r.ProcessId`;
}

export function spawnDetachedNode(script, args, { cwd, env, launcher } = {}) {
  const how = launcher || process.env.OMH_LAUNCHER || 'detached';
  if (IS_WIN && how === 'wmi') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wmiLaunchCommand(script, args, cwd)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const pid = Number(String(r.stdout || '').trim().split(/\s+/).pop());
    if (r.status === 0 && pid > 0) return pid;
    // fall through to the normal launcher rather than not starting the job at all
  }
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export function killTree(pid, { force = false } = {}) {
  if (!pid) return false;
  if (IS_WIN) {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return r.status === 0;
  }
  const sig = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig); // process group (worker was spawned detached)
    return true;
  } catch {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }
}
