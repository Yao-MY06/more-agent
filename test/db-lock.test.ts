/** Another process holding the database for a moment: a read-only command, or SQLite recovering after a kill. Nobody should die of it. */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { decisionRows } from '../src/report.ts'
import { Runtime } from '../src/runtime.ts'
import { readTickets } from '../src/tickets-view.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { useHome } from './helpers.ts'

const HOLD_MS = 1500
const TEST_TIMEOUT_MS = 30_000
const home = useHome()

/**
 * The rollback journal is used because in WAL mode readers pass straight through a writer's lock, and a test
 * cannot time the recovery after a kill, which is the real case. @returns once the lock is held, with a wait for its release.
 */
function holdLock(file: string): Promise<{ released: Promise<void> }> {
  const script = `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.argv[1])
    db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE')
    console.log('locked')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS})
    db.exec('COMMIT')
    db.close()`
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script, file], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const released = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return new Promise((resolve) => child.stdout.once('data', () => resolve({ released })))
}

function createDatabase(): void {
  new Store(home().db).close()
}

describe('a database locked for a moment', { timeout: TEST_TIMEOUT_MS }, () => {
  it('makes a starting runner wait, instead of killing it', async () => {
    createDatabase()
    const { released } = await holdLock(home().db)
    const llm = { complete: () => Promise.reject(new Error('not called')) }
    const { runtime, release } = await Runtime.open({
      paths: home(),
      llm,
      onLockLost: (error) => {
        throw error
      },
    })
    await runtime.close()
    await release()
    await released
  })
  it('makes a read-only command wait, instead of failing', async () => {
    createDatabase()
    const { released } = await holdLock(home().db)
    expect(readTickets(home())).toEqual([])
    expect(decisionRows(home())).toEqual([])
    await released
  })
})
