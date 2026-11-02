import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { killTurn, readTurn, startTurn, type TurnSpec, type TurnView } from '../src/manager/turn.ts'
import { useHome } from './helpers.ts'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-turn.mjs')
const TICK_MS = 100
const WAIT_LIMIT_MS = 15_000
const LONG_MS = 60_000
const ANCIENT_MS = 3_600_000
const TEST_TIMEOUT_MS = 30_000

const home = useHome()
const jobDir = () => join(home().home, 'job')
const spec = (mode: string, overrides: Partial<TurnSpec> = {}): TurnSpec => ({
  file: process.execPath,
  args: [FAKE, mode],
  cwd: home().home,
  stdin: '',
  timeoutMs: LONG_MS,
  tickMs: TICK_MS,
  ...overrides,
})

async function untilFinished(dir: string): Promise<TurnView> {
  const started = Date.now()
  for (;;) {
    const view = readTurn(dir)
    if (view.phase !== 'running') return view
    if (Date.now() - started > WAIT_LIMIT_MS) throw new Error('The turn did not finish')
    await new Promise((resolve) => setTimeout(resolve, TICK_MS))
  }
}

async function untilChild(dir: string): Promise<number> {
  const started = Date.now()
  for (;;) {
    const pid = readTurn(dir).childPid
    if (pid) return pid
    if (Date.now() - started > WAIT_LIMIT_MS) throw new Error('The turn did not start')
    await new Promise((resolve) => setTimeout(resolve, TICK_MS))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function writeStatus(dir: string, status: object): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'spec.json'), '{}')
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status))
}

describe('a turn process', { timeout: TEST_TIMEOUT_MS }, () => {
  it('when the command succeeds, its stdout and exit code can be collected', async () => {
    startTurn(jobDir(), spec('echo', { stdin: '中文 "quoted" & %PATH%' }))
    const view = await untilFinished(jobDir())
    expect(view).toMatchObject({ phase: 'finished', state: 'exited', exitCode: 0 })
    expect(view.stdout).toBe('中文 "quoted" & %PATH%')
  })
  it('when the command fails, the exit code and stderr are kept', async () => {
    startTurn(jobDir(), spec('fail'))
    const view = await untilFinished(jobDir())
    expect(view).toMatchObject({ phase: 'finished', state: 'exited', exitCode: 3 })
    expect(view.stderr).toContain('it broke')
  })
  it('when the command cannot start, the turn finishes and says so', async () => {
    startTurn(jobDir(), spec('echo', { file: join(home().home, 'no-such-program.exe') }))
    const view = await untilFinished(jobDir())
    expect(view).toMatchObject({ phase: 'finished', state: 'failed-to-start' })
    expect(view.error).toBeTruthy()
  })
  it('when the hard timeout passes, the process is killed and the turn says timeout', async () => {
    startTurn(jobDir(), spec('sleep', { timeoutMs: 500 }))
    const pid = await untilChild(jobDir())
    const view = await untilFinished(jobDir())
    expect(view).toMatchObject({ phase: 'finished', state: 'timeout' })
    expect(alive(pid)).toBe(false)
  })
  it('when killed, the process and the child it started are both gone', async () => {
    startTurn(jobDir(), spec('sleep-with-child'))
    const pid = await untilChild(jobDir())
    const started = Date.now()
    let grandchild = 0
    while (!grandchild && Date.now() - started < WAIT_LIMIT_MS) {
      const match = readTurn(jobDir()).stdout.match(/child=(\d+)/)
      grandchild = Number(match?.[1] ?? 0)
      await new Promise((resolve) => setTimeout(resolve, TICK_MS))
    }
    expect(grandchild).toBeGreaterThan(0)
    killTurn(jobDir())
    const view = await untilFinished(jobDir())
    expect(view).toMatchObject({ phase: 'finished', state: 'killed' })
    expect(alive(pid)).toBe(false)
    expect(alive(grandchild)).toBe(false)
  })
  it('when killed before it could start, the command never runs', async () => {
    mkdirSync(jobDir(), { recursive: true })
    writeFileSync(join(jobDir(), 'kill'), '')
    startTurn(jobDir(), spec('echo', { stdin: 'must not run' }))
    const view = await untilFinished(jobDir())
    expect(view).toMatchObject({ phase: 'finished', state: 'killed' })
    expect(view.stdout).toBe('')
  })
})

describe('reading a turn', () => {
  const now = () => new Date().toISOString()
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const DEAD_PID = 999_999_99

  it('when the job directory does not exist, the turn is dead', () => {
    expect(readTurn(jobDir()).phase).toBe('dead')
  })
  it('when the heartbeat is fresh, the turn is running', () => {
    writeStatus(jobDir(), {
      state: 'running',
      supervisorPid: DEAD_PID,
      startedAt: now(),
      heartbeatAt: now(),
      timeoutMs: LONG_MS,
    })
    expect(readTurn(jobDir()).phase).toBe('running')
  })
  it('when the heartbeat is stale and the supervisor is gone, the turn is dead', () => {
    writeStatus(jobDir(), {
      state: 'running',
      supervisorPid: DEAD_PID,
      startedAt: ago(LONG_MS),
      heartbeatAt: ago(LONG_MS),
      timeoutMs: ANCIENT_MS,
    })
    expect(readTurn(jobDir()).phase).toBe('dead')
  })
  it('when the heartbeat is stale but the supervisor lives, as after the machine slept, the turn is still running', () => {
    writeStatus(jobDir(), {
      state: 'running',
      supervisorPid: process.pid,
      startedAt: ago(LONG_MS),
      heartbeatAt: ago(LONG_MS),
      timeoutMs: ANCIENT_MS,
    })
    expect(readTurn(jobDir()).phase).toBe('running')
  })
  it('when a stale turn is long past its hard timeout, a reused process id cannot keep it alive', () => {
    writeStatus(jobDir(), {
      state: 'running',
      supervisorPid: process.pid,
      startedAt: ago(ANCIENT_MS),
      heartbeatAt: ago(ANCIENT_MS),
      timeoutMs: LONG_MS,
    })
    expect(readTurn(jobDir()).phase).toBe('dead')
  })
  it('when the supervisor has not written yet, a fresh turn counts as running and an old one as dead', () => {
    mkdirSync(jobDir(), { recursive: true })
    writeFileSync(join(jobDir(), 'spec.json'), '{}')
    expect(readTurn(jobDir()).phase).toBe('running')
    const old = new Date(Date.now() - LONG_MS)
    utimesSync(join(jobDir(), 'spec.json'), old, old)
    expect(readTurn(jobDir()).phase).toBe('dead')
  })
  it('when the status file is corrupt, a turn is judged by its spec instead of crashing the runner', () => {
    mkdirSync(jobDir(), { recursive: true })
    writeFileSync(join(jobDir(), 'spec.json'), '{}')
    writeFileSync(join(jobDir(), 'status.json'), '{broken')
    expect(readTurn(jobDir()).phase).toBe('running')
  })
  it('killing a job that never existed does nothing', () => {
    expect(() => killTurn(jobDir())).not.toThrow()
  })
})
