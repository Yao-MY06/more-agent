/** The M0 acceptance test: real processes, really killed, and no request lost or decided twice. */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { useHome } from './helpers.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'lib', 'bin', 'resident.js')
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-claude.mjs')
const REQUESTS = 12
const FAKE_CALL_MS = 400
const KILL_AFTER_CALLS = 2
const POLL_MS = 50
const BUILD_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 120_000

const home = useHome()
const log = () => join(home().home, 'calls.jsonl')
const callCount = () => (existsSync(log()) ? readFileSync(log(), 'utf8').split('\n').filter(Boolean).length : 0)

function environment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RESIDENT_HOME: home().home,
    RESIDENT_LEADER_COMMAND: JSON.stringify([process.execPath, FAKE]),
    FAKE_CLAUDE_LOG: log(),
    FAKE_CLAUDE_DELAY_MS: String(FAKE_CALL_MS),
  }
}

function cli(...args: string[]): string {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    env: environment(),
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function startRunner(): ChildProcess {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'run'], {
    env: environment(),
    stdio: 'ignore',
  })
}

async function untilCalls(calls: number): Promise<void> {
  while (callCount() < calls) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
}

function kill(runner: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    runner.once('exit', () => resolve())
    runner.kill('SIGKILL')
  })
}

describe('a runner killed in the middle of its work', () => {
  beforeAll(() => {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const build = spawnSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(build.status, build.stdout).toBe(0)
  }, BUILD_TIMEOUT_MS)

  it(
    'loses no request and decides none twice, across two kills',
    async () => {
      cli('project', 'add', 'alpha', home().home, '--brief', 'Alpha')
      const replay = join(home().home, 'replay.jsonl')
      const lines = Array.from({ length: REQUESTS }, (_, index) =>
        JSON.stringify({ id: `r${index}`, text: `request ${index}` }),
      )
      writeFileSync(replay, `${lines.join('\n')}\n`)
      cli('replay', replay)

      for (const round of [1, 2]) {
        const before = callCount()
        const runner = startRunner()
        await untilCalls(before + KILL_AFTER_CALLS * round)
        await kill(runner)
      }

      const midway = JSON.parse(cli('decisions')) as unknown[]
      expect(midway.length).toBeLessThan(REQUESTS)

      cli('run', '--until-idle')

      const rows = JSON.parse(cli('decisions')) as { triggerId: string; outcome: string }[]
      const expected = Array.from({ length: REQUESTS }, (_, index) => `replay:r${index}`).sort()
      expect(rows.map((row) => row.triggerId).sort()).toEqual(expected)
      expect(rows.every((row) => row.outcome === 'alpha')).toBe(true)

      const status = JSON.parse(cli('status', '--json')) as Record<string, number>
      expect(status).toMatchObject({
        spoolWaiting: 0,
        triggers: REQUESTS,
        tickets: REQUESTS,
        effects: 0,
        activeThreads: 0,
        sent: 0,
      })
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'calls the Leader as Opus 5.5 at medium effort with no tools, from its own empty directory',
    async () => {
      cli('project', 'add', 'alpha', home().home, '--brief', 'Alpha')
      cli('say', 'hello')
      cli('run', '--until-idle')
      const call = JSON.parse(readFileSync(log(), 'utf8').split('\n')[0] ?? '{}') as { args: string[]; cwd: string }
      expect(call.args.slice(0, 5)).toEqual(['-p', '--model', 'claude-opus-5-5', '--effort', 'medium'])
      expect(call.args).toContain('--restricted')
      expect(call.cwd.toLowerCase()).toBe(home().leaderCwd.toLowerCase())
    },
    TEST_TIMEOUT_MS,
  )
})
