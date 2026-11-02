// Runs one manager turn, detached from the runner, so the runner can die or restart while the turn goes on and finishes.
// Plain JavaScript with no imports from the project: it must start without a build.
// Follows opus-manager's harness/src/supervisor.js, whose rule still holds: silence never kills, only the hard timeout does.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FORCE_KILL_DELAY_MS = 5_000
const EXIT_FLUSH_MS = 50
const IS_WINDOWS = process.platform === 'win32'

const specPath = process.argv[2]
const dir = dirname(specPath)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const statusPath = join(dir, 'status.json')
const killPath = join(dir, 'kill')
const status = {
  state: 'starting',
  supervisorPid: process.pid,
  startedAt: new Date().toISOString(),
  timeoutMs: spec.timeoutMs,
}
let finished = false

function save() {
  status.heartbeatAt = new Date().toISOString()
  const temporary = `${statusPath}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(status))
    renameSync(temporary, statusPath)
  } catch {
    // A missed heartbeat is harmless: the next tick writes again, and the final status retries below.
  }
}

function finish(patch) {
  if (finished) return
  finished = true
  Object.assign(status, patch, { endedAt: new Date().toISOString() })
  save()
  setTimeout(() => process.exit(0), EXIT_FLUSH_MS)
}

/** The whole tree: a turn's model process starts children of its own, such as MCP servers. */
function killTree(pid, force) {
  if (!pid) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // Already gone.
  }
}

function start() {
  const out = openSync(join(dir, 'stdout.txt'), 'a')
  const err = openSync(join(dir, 'stderr.txt'), 'a')
  const child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    stdio: ['pipe', out, err],
    detached: !IS_WINDOWS,
    windowsHide: true,
    windowsVerbatimArguments: !!spec.windowsVerbatimArguments,
  })
  closeSync(out)
  closeSync(err)
  return child
}

function supervise(child) {
  let ending
  child.on('error', (error) => finish({ state: 'failed-to-start', error: error.message }))
  child.stdin.on('error', () => {})
  child.stdin.end(spec.stdin)
  status.state = 'running'
  status.childPid = child.pid
  save()
  const end = (state) => {
    ending ??= state
    killTree(child.pid, false)
    setTimeout(() => killTree(child.pid, true), FORCE_KILL_DELAY_MS).unref()
  }
  const tick = setInterval(() => {
    if (!ending && existsSync(killPath)) end('killed')
    if (!ending && Date.now() - Date.parse(status.startedAt) > spec.timeoutMs) end('timeout')
    save()
  }, spec.tickMs)
  child.on('exit', (code, signal) => {
    clearInterval(tick)
    finish({ state: ending ?? 'exited', exitCode: code, signal: signal ?? null })
  })
}

save()
if (existsSync(killPath)) {
  finish({ state: 'killed' })
} else {
  try {
    supervise(start())
  } catch (error) {
    finish({ state: 'failed-to-start', error: String(error?.message ?? error) })
  }
}
