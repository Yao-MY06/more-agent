// Worker adapters: how to drive each AI CLI headlessly.
//
// An adapter is plain data so users can add or fix one in .omh/config.json ("adapters")
// without touching code. Argument templates are arrays:
//   - a string token is emitted as-is after placeholder substitution;
//   - a nested array is an optional group, emitted only if every placeholder in it has a value.
// Placeholders: {prompt} {model} {provider} {lastMessageFile} {cwd}
//
// These presets were written from each tool's public docs. Flags drift between versions,
// so they are NOT trusted blindly: `omh probe <adapter>` checks `helpMustContain` against
// the tool's real --help output, and `omh trial <worker>` runs a tiny real ticket.
// A worker is only "verified" once its trial passed.
import { OmhError } from './util.js';

export const PRESETS = {
  pi: {
    bin: 'pi',
    title: 'Pi Coding Agent',
    build: ['-p', ['--provider', '{provider}'], ['--model', '{model}'], '{prompt}'],
    review: ['-p', ['--provider', '{provider}'], ['--model', '{model}'], '--tools', 'read,grep,find,ls', '{prompt}'],
    helpMustContain: ['--model', '--provider', '--tools'],
    finalAnswer: 'stdout',
    usage: 'generic',
  },
  claude: {
    bin: 'claude',
    title: 'Claude Code (as a worker)',
    build: ['-p', '{prompt}', ['--model', '{model}'], '--dangerously-skip-permissions', '--output-format', 'json'],
    review: ['-p', '{prompt}', ['--model', '{model}'], '--allowedTools', 'Read,Grep,Glob', '--output-format', 'json'],
    helpMustContain: ['--print', '--model', '--output-format', '--allowedTools'],
    finalAnswer: 'claude-json',
    usage: 'claude-json',
  },
  codex: {
    bin: 'codex',
    title: 'OpenAI Codex CLI',
    // codex-cli 0.165 dropped --full-auto; exec never stops for approvals, so the sandbox alone keeps builds in the workspace.
    build: ['exec', ['--model', '{model}'], '--sandbox', 'workspace-write', '--skip-git-repo-check', '-o', '{lastMessageFile}', '{prompt}'],
    review: ['exec', ['--model', '{model}'], '--sandbox', 'read-only', '--skip-git-repo-check', '-o', '{lastMessageFile}', '{prompt}'],
    helpCommand: ['exec', '--help'],
    helpMustContain: ['--model', '--sandbox', '--skip-git-repo-check', '--output-last-message'],
    finalAnswer: 'file',
    usage: 'codex-text',
  },
  gemini: {
    bin: 'gemini',
    title: 'Google Gemini CLI',
    build: [['-m', '{model}'], '--yolo', '--output-format', 'json', '-p', '{prompt}'],
    review: [['-m', '{model}'], '--approval-mode', 'default', '--output-format', 'json', '-p', '{prompt}'],
    helpMustContain: ['--model', '--yolo', '--prompt', '--output-format'],
    finalAnswer: 'gemini-json',
    usage: 'gemini-json',
  },
  qwen: {
    bin: 'qwen',
    title: 'Qwen Code',
    build: [['-m', '{model}'], '--yolo', '-p', '{prompt}'],
    review: [['-m', '{model}'], '-p', '{prompt}'],
    helpMustContain: ['--model', '--yolo', '--prompt'],
    finalAnswer: 'stdout',
    usage: 'generic',
  },
  'cursor-agent': {
    bin: 'cursor-agent',
    title: 'Cursor Agent CLI',
    build: ['-p', '--force', ['--model', '{model}'], '--output-format', 'text', '{prompt}'],
    review: ['-p', ['--model', '{model}'], '--output-format', 'text', '{prompt}'],
    helpMustContain: ['--print', '--force', '--model', '--output-format'],
    finalAnswer: 'stdout',
    usage: 'generic',
  },
  opencode: {
    bin: 'opencode',
    title: 'OpenCode',
    build: ['run', ['-m', '{model}'], '{prompt}'],
    review: ['run', ['-m', '{model}'], '--agent', 'plan', '{prompt}'],
    helpCommand: ['run', '--help'],
    helpMustContain: ['--model', '--agent'],
    finalAnswer: 'stdout',
    usage: 'generic',
  },
  codebuddy: {
    // Tencent CodeBuddy Code / WorkBuddy CLI (npm @tencent-ai/codebuddy-code). Docs: workbuddy.ai/docs/cli.
    // -y is required for non-interactive runs; reviews use the read-only "plan" permission mode.
    bin: 'codebuddy',
    title: 'CodeBuddy Code (WorkBuddy CLI)',
    // stream-json: one JSON event per line as it happens, so the log grows while the worker
    // works (plain json printed nothing for 15 minutes on a real run, indistinguishable from a hang)
    // {tools}: limit the loaded tools (e.g. "Read,Write,Edit,Bash,PowerShell,Glob,Grep"). Every turn
    // resends every tool schema; by default 60+ tools cost ~22k tokens per call.
    build: ['-p', '{prompt}', ['--model', '{model}'], ['--effort', '{effort}'], ['--tools', '{tools}'], '-y', '--output-format', 'stream-json'],
    review: ['-p', '{prompt}', ['--model', '{model}'], ['--effort', '{effort}'], ['--tools', '{reviewTools}'], '--permission-mode', 'plan', '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit', '--output-format', 'stream-json'],
    helpMustContain: ['--print', '--model', '--effort', '--output-format', '--permission-mode', '--dangerously-skip-permissions'],
    finalAnswer: 'claude-json',
    usage: 'codebuddy-json',
  },
  commandcode: {
    // Command Code (npm command-code, commandcode.ai). Without -m it runs the account's default model, so
    // set one on the worker: its vendor is what cross-vendor review compares, not "Command Code".
    // Measured on 1.88.2, Windows: in -p mode a built-in gate blocks edit_file, write_file and shell_command unless
    // --yolo is given, and permissions.allow does not lift it, so a build has no narrower grant than --yolo.
    // accept-edits and the default mode are NOT safer: the gate leaves out the powershell tool, which ran
    // Set-Content and wrote the file anyway. plan is the only mode that refused writes, so reviews use it.
    bin: 'command-code',
    title: 'Command Code',
    // json is an event stream, so the log grows while it works; every token repeats the whole message, so it grows fast.
    build: ['-p', '{prompt}', ['--model', '{model}'], ['--effort', '{effort}'], '--trust', '--skip-onboarding', '--no-auto-update', '--yolo', '--output-format', 'json'],
    review: ['-p', '{prompt}', ['--model', '{model}'], ['--effort', '{effort}'], '--trust', '--skip-onboarding', '--no-auto-update', '--permission-mode', 'plan', '--output-format', 'json'],
    helpMustContain: ['--print', '--model', '--effort', '--output-format', '--permission-mode', '--yolo', '--trust', '--skip-onboarding', '--no-auto-update'],
    finalAnswer: 'commandcode-json',
    usage: 'commandcode-json',
  },
  aider: {
    bin: 'aider',
    title: 'Aider',
    build: ['--message', '{prompt}', '--yes-always', '--no-auto-commits', '--no-check-update', ['--model', '{model}']],
    review: null, // aider has no trustworthy read-only mode; don't use it as a reviewer
    helpMustContain: ['--message', '--yes-always', '--no-auto-commits'],
    finalAnswer: 'stdout',
    usage: 'generic',
  },
};

export function getAdapter(config, name) {
  const custom = config.adapters?.[name];
  const preset = PRESETS[name];
  if (!custom && !preset) throw new OmhError(`unknown adapter "${name}". Known: ${Object.keys({ ...PRESETS, ...(config.adapters || {}) }).join(', ')}`, 'E_ADAPTER');
  return { name, binArgs: [], promptVia: 'arg', finalAnswer: 'stdout', usage: 'generic', ...(preset || {}), ...(custom || {}) };
}

export function listAdapters(config) {
  return [...new Set([...Object.keys(PRESETS), ...Object.keys(config.adapters || {})])];
}

function fill(token, vars) {
  return token.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}
function placeholders(token) {
  return [...token.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

export function expandTemplate(tpl, vars) {
  const out = [];
  for (const tok of tpl) {
    if (Array.isArray(tok)) {
      const need = tok.flatMap(placeholders);
      if (need.every((k) => vars[k] != null && vars[k] !== '')) out.push(...tok.map((t) => fill(t, vars)));
    } else {
      if (tok === '{prompt}' && vars.__promptViaStdin) continue;
      out.push(fill(tok, vars));
    }
  }
  return out;
}

// Build the argv for one run. mode = 'build' | 'review'.
export function buildArgs(adapter, mode, vars) {
  const tpl = adapter[mode];
  if (!tpl) throw new OmhError(`adapter "${adapter.name}" has no ${mode} mode`, 'E_ADAPTER_MODE');
  const v = { ...vars, __promptViaStdin: adapter.promptVia === 'stdin' };
  return [...(adapter.binArgs || []), ...expandTemplate(tpl, v)];
}

// ---- usage parsing (best effort; returns null when the tool doesn't report usage) ----

// CLIs that print an array of events (CodeBuddy's --output-format json) end with a
// {"type":"result"} element; that element is the one with the answer and the totals.
function pickResult(v) {
  if (!Array.isArray(v)) return v;
  return [...v].reverse().find((e) => e && e.type === 'result') || v[v.length - 1] || null;
}

// All events of a run: a JSON array (CodeBuddy --output-format json) or JSON lines (stream-json).
function allJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {}
  const events = [];
  for (const l of text.split(/\r?\n/)) {
    const s = l.trim();
    if (!s.startsWith('{')) continue;
    try {
      events.push(JSON.parse(s));
    } catch {}
  }
  return events.length ? events : null;
}

function lastJsonObject(text) {
  const t = text.trim();
  try {
    return pickResult(JSON.parse(t));
  } catch {}
  // JSON lines: prefer the result event wherever it is, else the last object line
  const evs = allJson(t);
  if (Array.isArray(evs)) {
    const r = [...evs].reverse().find((e) => e && e.type === 'result');
    if (r) return r;
  }
  // fall back: last line that parses as an object
  const lines = t.split(/\r?\n/).reverse();
  for (const l of lines) {
    const s = l.trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        return JSON.parse(s);
      } catch {}
    }
  }
  const i = t.lastIndexOf('\n{');
  if (i >= 0) {
    try {
      return JSON.parse(t.slice(i + 1));
    } catch {}
  }
  return null;
}

export function parseUsage(kind, logText) {
  if (!logText) return null;
  try {
    if (kind === 'claude-json') {
      const j = lastJsonObject(logText);
      if (!j) return null;
      const u = j.usage || {};
      return {
        costUsd: j.total_cost_usd ?? j.cost_usd ?? null,
        inputTokens: u.input_tokens == null ? null : (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens ?? null,
        cacheReadTokens: u.cache_read_input_tokens ?? null,
        cacheWriteTokens: u.cache_creation_input_tokens ?? null,
        turns: j.num_turns ?? null,
      };
    }
    if (kind === 'codebuddy-json') {
      // total_cost_usd is always 0 here: CodeBuddy bills in credits, reported per model call.
      const all = allJson(logText);
      const j = lastJsonObject(logText);
      if (!j) return null;
      const events = Array.isArray(all) ? all : [];
      // credits are only present in the json (array) format; stream-json omits them → unknown, never 0
      const withCredit = events.filter((e) => e?.providerData?.rawUsage?.credit != null);
      const credits = withCredit.reduce((s, e) => s + (Number(e.providerData.rawUsage.credit) || 0), 0);
      const u = j.usage || {};
      const cat = j._meta?.['codebuddy.ai/usageByCategory'];
      return {
        costUsd: null,
        credits: withCredit.length ? Number(credits.toFixed(4)) : null,
        inputTokens: u.input_tokens ?? null,
        outputTokens: u.output_tokens ?? null,
        cacheReadTokens: u.cache_read_input_tokens ?? null,
        turns: j.num_turns ?? null,
        // per-call context overhead: tool schemas alone were 22k of 25k tokens on a real run
        contextOverhead: cat ? { tools: cat.tools ?? null, systemPrompt: cat.systemPrompt ?? null, mcp: cat.mcp ?? null } : undefined,
      };
    }
    if (kind === 'commandcode-json') {
      // No cost is reported: the account bills by its own plan, so it stays unknown rather than 0.
      const j = lastJsonObject(logText);
      if (j?.type !== 'result') return null;
      const events = allJson(logText);
      const u = j.usage || {};
      return {
        costUsd: null,
        inputTokens: u.inputTokens ?? null,
        outputTokens: u.outputTokens ?? null,
        cacheReadTokens: u.cacheReadTokens ?? null,
        cacheWriteTokens: u.cacheWriteTokens ?? null,
        turns: Array.isArray(events) ? events.filter((e) => e?.event?.type === 'turn_start').length : null,
      };
    }
    if (kind === 'gemini-json') {
      const j = lastJsonObject(logText);
      const models = j?.stats?.models;
      if (!models) return null;
      let input = 0, output = 0, calls = 0;
      for (const m of Object.values(models)) {
        input += m.tokens?.prompt || m.tokens?.input || 0;
        output += m.tokens?.candidates || m.tokens?.output || 0;
        calls += m.api?.totalRequests || 0;
      }
      return { costUsd: null, inputTokens: input || null, outputTokens: output || null, calls: calls || null };
    }
    if (kind === 'codex-text') {
      const m = [...logText.matchAll(/tokens used:?\s*([\d,]+)/gi)].pop();
      return m ? { costUsd: null, totalTokens: Number(m[1].replace(/,/g, '')) } : null;
    }
    // generic: look for a cost figure printed by the tool
    const cost = [...logText.matchAll(/(?:total[_ ]?cost|cost)[^\d$\n]{0,12}\$?\s*([0-9]+\.[0-9]+)/gi)].pop();
    const tok = [...logText.matchAll(/(?:total[_ ]?tokens|tokens used)[^\d\n]{0,8}([\d,]+)/gi)].pop();
    if (!cost && !tok) return null;
    return { costUsd: cost ? Number(cost[1]) : null, totalTokens: tok ? Number(tok[1].replace(/,/g, '')) : null };
  } catch {
    return null;
  }
}

// Why did the worker fail? Structured CLIs put the reason in one field; everyone else
// leaves it on a line that says "error". Best effort — null when we can't tell.
export function extractError(logText) {
  if (!logText) return null;
  const j = lastJsonObject(logText);
  if (j) {
    const cand = j.is_error
      ? j.result || j.error?.message
      : j.error?.message || (typeof j.error === 'string' ? j.error : null);
    if (typeof cand === 'string' && cand.trim()) return cand.trim().slice(0, 600);
  }
  const lines = logText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  const hit = lines.find((l) => /(^|\W)(error|exception|fatal|denied|EACCES|EPERM|ENOENT)(\W|:|$)/i.test(l));
  return hit ? hit.slice(0, 600) : null;
}

// Extract the final answer (used for reviews: the reviewer's last message is the report).
export function extractFinalAnswer(kind, logText, lastMessageText) {
  if (kind === 'file') return lastMessageText || logText;
  if (kind === 'claude-json') {
    const j = lastJsonObject(logText);
    return j?.result ?? logText;
  }
  if (kind === 'commandcode-json') {
    const j = lastJsonObject(logText);
    return j?.finalText || logText;
  }
  if (kind === 'gemini-json') {
    const j = lastJsonObject(logText);
    return j?.response ?? logText;
  }
  return logText;
}
