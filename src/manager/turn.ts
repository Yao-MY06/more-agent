/**
 * One manager turn as a process that outlives the runner. The runner starts it and later collects what it left in its job
 * directory, so a runner crash neither kills a turn nor makes a restart start a second one beside it.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { supervisorPath } from '../config.ts'

/** How long the supervisor may stay silent before anyone looks at whether it still lives. */
const STALE_AFTER_MS = 30_000
/** Reused process ids must not keep a turn alive forever: past its hard timeout by this much, it is over. */
const TIMEOUT_GRACE_MS = 60_000
const START_GRACE_MS = 30_000
const DEFAULT_TICK_MS = 2_000

export interface TurnSpec {
  file: string
  args: readonly string[]
  windowsVerbatimArguments?: boolean
  cwd: string
  stdin: string
  timeoutMs: number
  tickMs?: number
}

const StatusSchema = z.looseObject({
  state: z.string(),
  supervisorPid: z.number().optional(),
  childPid: z.number().optional(),
  startedAt: z.string().optional(),
  heartbeatAt: z.string().optional(),
  timeoutMs: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  error: z.string().optional(),
})
type TurnStatus = z.infer<typeof StatusSchema>

export interface TurnView {
  /** `dead` means nothing is running and nothing was left to collect: the machine or the supervisor went down mid-turn. */
  phase: 'running' | 'finished' | 'dead'
  state?: string
  exitCode?: number | null
  childPid?: number
  error?: string
  stdout: string
  stderr: string
}

const FINISHED_STATES: readonly string[] = ['exited', 'timeout', 'killed', 'failed-to-start']

/** @throws when the job directory cannot be written or the supervisor cannot be found. */
export function startTurn(directory: string, spec: TurnSpec): void {
  mkdirSync(directory, { recursive: true })
  const specPath = join(directory, 'spec.json')
  writeFileSync(specPath, JSON.stringify({ tickMs: DEFAULT_TICK_MS, ...spec }))
  const supervisor = spawn(process.execPath, [supervisorPath(), specPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  supervisor.unref()
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function readStatus(directory: string): TurnStatus | undefined {
  try {
    return StatusSchema.parse(JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8')))
  } catch {
    return undefined
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function ageMs(time: string | undefined): number {
  return time ? Date.now() - Date.parse(time) : Number.POSITIVE_INFINITY
}

function phaseOf(directory: string, status: TurnStatus | undefined): TurnView['phase'] {
  if (status && FINISHED_STATES.includes(status.state)) return 'finished'
  if (!status) {
    const spec = join(directory, 'spec.json')
    return existsSync(spec) && Date.now() - statSync(spec).mtimeMs < START_GRACE_MS ? 'running' : 'dead'
  }
  if (ageMs(status.heartbeatAt) < STALE_AFTER_MS) return 'running'
  const overdue = ageMs(status.startedAt) > (status.timeoutMs ?? 0) + TIMEOUT_GRACE_MS
  return alive(status.supervisorPid) && !overdue ? 'running' : 'dead'
}

export function readTurn(directory: string): TurnView {
  const status = readStatus(directory)
  return {
    phase: phaseOf(directory, status),
    stdout: readText(join(directory, 'stdout.txt')),
    stderr: readText(join(directory, 'stderr.txt')),
    ...(status?.state ? { state: status.state } : {}),
    ...(status?.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status?.childPid ? { childPid: status.childPid } : {}),
    ...(status?.error ? { error: status.error } : {}),
  }
}

/** Asks the supervisor to end the turn: a marker file, so it works from any process, even before the turn got going. */
export function killTurn(directory: string): void {
  if (existsSync(directory)) writeFileSync(join(directory, 'kill'), '')
}
