/** Stopping a project's workers: against a scripted `omh` for the rules, and against the real one where it is available. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killWorkers, runningTickets } from '../src/manager/omh.ts'
import { useHome } from './helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_OMH = join(HERE, 'fixtures', 'fake-omh.mjs')
const REAL_OMH = join(HERE, '..', '..', 'opus-manager', 'harness', 'bin', 'omh.js')
const REAL_WORKER = join(HERE, '..', '..', 'opus-manager', 'harness', 'test', 'fixtures', 'fake-worker.js')
const REASON = '工单被停止'
const POLL_MS = 100
const WAIT_LIMIT_MS = 15_000
const REAL_TEST_TIMEOUT_MS = 60_000

const home = useHome()
const root = () => home().home
const record = (name: string) => {
  const file = join(root(), name)
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
}
const running = (jobs: unknown[]) => writeFileSync(join(root(), 'fake-omh-running.json'), JSON.stringify(jobs))
function inDoing(...names: string[]): void {
  mkdirSync(join(root(), '_tickets', 'doing'), { recursive: true })
  for (const name of names) writeFileSync(join(root(), '_tickets', 'doing', name), '')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('stopping workers', () => {
  it('when a build runs, it is killed and its ticket leaves doing with the reason', async () => {
    running(['T1'])
    inDoing('T1-add.md')
    await expect(killWorkers(FAKE_OMH, root(), REASON)).resolves.toEqual([])
    expect(record('fake-omh-killed.txt')).toEqual(['T1 build'])
    expect(record('fake-omh-moved.txt')).toEqual([`T1 blocked ${REASON}`])
  })

  it('when a review runs, it is killed by its own phase, which a plain kill would miss', async () => {
    running([{ ticket: 'T1', phase: 'review-1' }])
    inDoing('T1-add.md')
    await killWorkers(FAKE_OMH, root(), REASON)
    expect(record('fake-omh-killed.txt')).toEqual(['T1 review-1'])
    await expect(runningTickets(FAKE_OMH, root())).resolves.toEqual([])
  })

  it('when one ticket has two jobs, both are killed and it moves once', async () => {
    running([
      { ticket: 'T1', phase: 'review-1' },
      { ticket: 'T1', phase: 'review-2' },
    ])
    inDoing('T1-add.md')
    await killWorkers(FAKE_OMH, root(), REASON)
    expect(record('fake-omh-killed.txt')).toEqual(['T1 review-1', 'T1 review-2'])
    expect(record('fake-omh-moved.txt')).toHaveLength(1)
  })

  it('when a review outlives an accepted ticket, the ticket stays where it is', async () => {
    running([{ ticket: 'T1', phase: 'review-1' }])
    await killWorkers(FAKE_OMH, root(), REASON)
    expect(record('fake-omh-killed.txt')).toEqual(['T1 review-1'])
    expect(record('fake-omh-moved.txt')).toEqual([])
  })

  it('does not mistake T10 in doing for T1', async () => {
    running(['T1'])
    inDoing('T10-other.md')
    await killWorkers(FAKE_OMH, root(), REASON)
    expect(record('fake-omh-moved.txt')).toEqual([])
  })

  it('leaves tickets alone that have no running job', async () => {
    running([])
    inDoing('T5-manual.md')
    await expect(killWorkers(FAKE_OMH, root(), REASON)).resolves.toEqual([])
    expect(record('fake-omh-moved.txt')).toEqual([])
  })

  it('when a ticket cannot be moved, says so instead of hiding it', async () => {
    running(['T1'])
    inDoing('T1-add.md')
    writeFileSync(join(root(), 'fake-omh-move-fails'), '')
    const failed = await killWorkers(FAKE_OMH, root(), REASON)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('T1')
  })
})

describe.runIf(existsSync(REAL_OMH) && existsSync(REAL_WORKER))('stopping a real omh job', () => {
  it('leaves nothing running and the ticket in blocked with the reason', {
    timeout: REAL_TEST_TIMEOUT_MS,
  }, async () => {
    vi.stubEnv('OMH_HOME', join(root(), 'omh-home'))
    vi.stubEnv('FAKE_MODE', 'sleep')
    mkdirSync(join(root(), 'omh-home'))
    const omh = (...args: string[]) =>
      spawnSync(process.execPath, [REAL_OMH, ...args], { cwd: root(), encoding: 'utf8' })
    expect(omh('init').status).toBe(0)
    const configPath = join(root(), '.omh', 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.adapters = {
      fake: {
        bin: process.execPath,
        binArgs: [REAL_WORKER],
        build: ['{prompt}'],
        helpMustContain: [],
        finalAnswer: 'stdout',
        usage: 'generic',
      },
    }
    config.workers = {
      builder: {
        adapter: 'fake',
        model: 'm',
        vendor: 'v',
        roles: ['build'],
        consent: { codeAccess: true, autoApprove: true },
      },
    }
    config.routing = { default: ['builder'] }
    writeFileSync(configPath, JSON.stringify(config))
    expect(omh('new', 'add', '--title', 'add', '--files', 'add.js').status).toBe(0)
    const dispatched = omh('dispatch', 'T1', '--force', '--reason', 'test')
    expect(dispatched.status, dispatched.stderr).toBe(0)
    const started = Date.now()
    while (!(await runningTickets(REAL_OMH, root())).length && Date.now() - started < WAIT_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    await expect(runningTickets(REAL_OMH, root())).resolves.toEqual(['T1'])

    await expect(killWorkers(REAL_OMH, root(), REASON)).resolves.toEqual([])

    await expect(runningTickets(REAL_OMH, root())).resolves.toEqual([])
    expect(readdirSync(join(root(), '_tickets', 'doing'))).toEqual([])
    const [blocked] = readdirSync(join(root(), '_tickets', 'blocked'))
    expect(blocked).toMatch(/^T1-/)
    expect(readFileSync(join(root(), '_tickets', 'blocked', blocked ?? ''), 'utf8')).toContain(REASON)
  })
})
