/** The real process boundary of a Leader call and of `resident run`, in-process so coverage sees it; only the `claude` binary is faked. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { ClaudeCli } from '../src/llm/claude-cli.ts'
import { decisionRows, readStatus } from '../src/report.ts'
import { ShadowOutbox } from '../src/shadow.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { useHome } from './helpers.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const FAKE = join(FIXTURES, 'fake-claude.mjs')
const FAILING = join(FIXTURES, 'failing-claude.mjs')
const SLOW_CALL_MS = 30_000
const INTERRUPT_AFTER_MS = 800
const LOCK_FREE_WAIT_MS = 300

const home = useHome()
const io = { out: () => {}, err: () => {} }
const request = {
  system: 'Registered projects:\n[{"id":"alpha"}]',
  user: JSON.stringify({ request: [{ text: '中文 "quoted" & %PATH%' }] }),
  schema: {},
}
const settings = (command: string[]) => ({ model: 'm', effort: 'low', command })

beforeEach(() => {
  vi.stubEnv('FAKE_CLAUDE_LOG', join(home().home, 'calls.jsonl'))
  vi.stubEnv('FAKE_CLAUDE_DELAY_MS', '0')
  vi.stubEnv('RESIDENT_LEADER_COMMAND', JSON.stringify([process.execPath, FAKE]))
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a Leader call through a real process', () => {
  it('when the CLI answers, the structured reply comes back and the request arrives intact over stdin', async () => {
    const result = await new ClaudeCli(settings([process.execPath, FAKE]), home().home).complete(request)
    expect(result.output).toMatchObject({ action: 'route', project: 'alpha' })
    expect(result.usage.costUsd).toBe(0.01)
    const call = JSON.parse(readFileSync(join(home().home, 'calls.jsonl'), 'utf8').trim())
    expect(call.card.request[0].text).toBe('中文 "quoted" & %PATH%')
  })
  it('when the CLI exits with an error, the call fails with what it said', async () => {
    const llm = new ClaudeCli(settings([process.execPath, FAILING]), home().home)
    await expect(llm.complete(request)).rejects.toThrow(/exited with 3.*quota exhausted/s)
  })
  it('when the command does not exist, the call fails naming it', async () => {
    const llm = new ClaudeCli(settings(['no-such-command-xyz']), home().home)
    await expect(llm.complete(request)).rejects.toThrow('Command not found: no-such-command-xyz')
  })
  it('when the run is cancelled, the process is stopped and the call fails', async () => {
    vi.stubEnv('FAKE_CLAUDE_DELAY_MS', String(SLOW_CALL_MS))
    const stop = new AbortController()
    const call = new ClaudeCli(settings([process.execPath, FAKE]), home().home).complete(request, stop.signal)
    setTimeout(() => stop.abort(), INTERRUPT_AFTER_MS)
    await expect(call).rejects.toThrow()
  })
})

describe('resident run', () => {
  it('with --until-idle, it decides what waits and exits', async () => {
    await main(['project', 'add', 'alpha', home().home, '--brief', 'b'], io, home())
    await main(['say', 'hello'], io, home())
    await expect(main(['run', '--until-idle'], io, home())).resolves.toBe(0)
    expect(decisionRows(home()).map((row) => row.outcome)).toEqual(['alpha'])
    expect(readStatus(home(), 0).sent).toBe(0)
  })
  it('when interrupted, it stops, keeps the unfinished request, and frees its lock for the next run', async () => {
    vi.stubEnv('FAKE_CLAUDE_DELAY_MS', String(SLOW_CALL_MS))
    await main(['project', 'add', 'alpha', home().home, '--brief', 'b'], io, home())
    await main(['say', 'hello'], io, home())
    const running = main(['run'], io, home())
    setTimeout(() => process.emit('SIGINT'), INTERRUPT_AFTER_MS)
    await expect(running).resolves.toBe(0)
    await new Promise((resolve) => setTimeout(resolve, LOCK_FREE_WAIT_MS))
    expect(existsSync(home().lock)).toBe(false)
    expect(readStatus(home(), 0)).toMatchObject({ triggers: 1, effects: 1 })
    vi.stubEnv('FAKE_CLAUDE_DELAY_MS', '0')
    await main(['run', '--until-idle'], io, home())
    expect(decisionRows(home())).toHaveLength(1)
  })
})

describe('the shadow outbox', () => {
  it('keeps a message as pending, reports it, and can withdraw it, without ever sending', () => {
    const store = new Store(join(home().home, 'outbox.sqlite'))
    const outbox = new ShadowOutbox(store)
    const channel = { source: 'cli', thread: 'cli:t', address: {} }
    outbox.send({ id: 'm', channel, text: 'hi', kind: 'reply' })
    expect(outbox.status('m')).toBe('pending')
    outbox.withdraw('m')
    expect(outbox.status('m')).toBeUndefined()
    store.close()
  })
})
