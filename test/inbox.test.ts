import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { appendInbox, readInbox, takeUnread } from '../src/inbox.ts'
import { LocalOutbox } from '../src/outbox.ts'
import { addProject, loadProjects } from '../src/projects.ts'
import { readStatus } from '../src/report.ts'
import { Runtime } from '../src/runtime.ts'
import { writeSpool } from '../src/spool.ts'
import { Effects } from '../vendor/dsh-superagent/src/app/effects.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { HealthBoard } from '../vendor/dsh-superagent/src/infra/health.ts'
import { ScriptedLlm, useHome, verdict } from './helpers.ts'

const home = useHome()
const at = '2026-11-02T00:00:00.000Z'
const entry = (id: string, text = id) => ({ id, at, thread: 'cli:t', kind: 'reply' as const, text })
const channel = { source: 'cli', thread: 'cli:t', address: {} }
const message = (id: string, ticketId?: string) => ({
  id,
  channel,
  text: `text ${id}`,
  kind: 'reply' as const,
  ...(ticketId ? { ticketId } : {}),
})

describe('inbox file', () => {
  it('when nothing was written, it is empty', () => {
    expect(readInbox(home())).toEqual({ entries: [], skipped: 0 })
    expect(takeUnread(home())).toEqual([])
  })
  it('when the same message is appended twice, as a crash before settling would do, a reader sees it once', () => {
    appendInbox(home(), entry('a'))
    appendInbox(home(), entry('a'))
    appendInbox(home(), entry('b'))
    expect(readInbox(home()).entries.map((value) => value.id)).toEqual(['a', 'b'])
  })
  it('when a write was cut off, the next message still arrives and the broken line is counted', () => {
    appendInbox(home(), entry('a'))
    appendFileSync(home().inbox, '{"id":"cut')
    appendInbox(home(), entry('b'))
    expect(readInbox(home())).toMatchObject({ entries: [{ id: 'a' }, { id: 'b' }], skipped: 1 })
  })
  it('when read, only messages not seen before come back', () => {
    appendInbox(home(), entry('a'))
    expect(takeUnread(home()).map((value) => value.id)).toEqual(['a'])
    expect(takeUnread(home())).toEqual([])
    appendInbox(home(), entry('b'))
    expect(takeUnread(home()).map((value) => value.id)).toEqual(['b'])
  })
})

describe('local outbox', () => {
  function outboxWith(shouldSend: () => boolean) {
    const store = new Store(join(home().home, 'outbox.sqlite'))
    const effects = new Effects(store, new HealthBoard())
    const outbox = new LocalOutbox({ store, effects, paths: home(), shouldSend })
    effects.start()
    return { store, effects, outbox }
  }

  it('when a message may be sent, it reaches the inbox and its receipt says sent', async () => {
    const { store, effects, outbox } = outboxWith(() => true)
    outbox.send(message('m'))
    await effects.idle()
    expect(outbox.status('m')).toBe('sent')
    expect(readInbox(home()).entries).toMatchObject([{ id: 'm', thread: 'cli:t', text: 'text m' }])
    await effects.drain()
    store.close()
  })
  it('when a message may not be sent, it stays pending and never reaches the inbox', async () => {
    const { store, effects, outbox } = outboxWith(() => false)
    outbox.send(message('m'))
    await effects.idle()
    expect(outbox.status('m')).toBe('pending')
    expect(existsSync(home().inbox)).toBe(false)
    await effects.drain()
    store.close()
  })
  it('when the same id is sent again, it goes out once', async () => {
    const { store, effects, outbox } = outboxWith(() => true)
    outbox.send(message('m'))
    outbox.send(message('m'))
    await effects.idle()
    expect(readInbox(home()).entries).toHaveLength(1)
    await effects.drain()
    store.close()
  })
  it('when several messages are sent, they arrive in order', async () => {
    const { store, effects, outbox } = outboxWith(() => true)
    for (const id of ['1', '2', '3']) outbox.send(message(id, 'ticket'))
    await effects.idle()
    expect(readInbox(home()).entries.map((value) => value.id)).toEqual(['1', '2', '3'])
    await effects.drain()
    store.close()
  })
  it('when a message is withdrawn before it goes out, it never arrives', async () => {
    const store = new Store(join(home().home, 'outbox.sqlite'))
    const effects = new Effects(store, new HealthBoard())
    const outbox = new LocalOutbox({ store, effects, paths: home(), shouldSend: () => true })
    outbox.send(message('m'))
    outbox.withdraw('m')
    effects.start()
    await effects.idle()
    expect(outbox.status('m')).toBeUndefined()
    expect(existsSync(home().inbox)).toBe(false)
    await effects.drain()
    store.close()
  })
})

describe('project execute switch', () => {
  it('when not asked for, execution stays off', () => {
    expect(addProject(home().projects, { id: 'alpha', path: home().home }).execute).toBe(false)
  })
  it('when a projects file predates the switch, its projects load with execution off', () => {
    writeFileSync(home().projects, JSON.stringify([{ id: 'old', path: home().home, brief: 'b' }]))
    expect(loadProjects(home().projects)).toMatchObject([{ id: 'old', execute: false }])
  })
  it('when registered again without the flag, execution turns back off', () => {
    addProject(home().projects, { id: 'alpha', path: home().home, execute: true })
    expect(addProject(home().projects, { id: 'alpha', path: home().home }).execute).toBe(false)
  })
  it('the command line sets the switch and the list shows it', async () => {
    const lines: string[] = []
    const io = { out: (line: string) => lines.push(line), err: () => {} }
    await main(['project', 'add', 'alpha', home().home, '--brief', 'b', '--execute'], io, home())
    await main(['project', 'add', 'beta', home().home, '--brief', 'b'], io, home())
    await main(['project', 'list'], io, home())
    expect(lines.slice(-2)).toEqual([`alpha\t执行\t${home().home}`, `beta\t影子\t${home().home}`])
  })
})

describe('what reaches the person', () => {
  async function run(llm: ScriptedLlm): Promise<void> {
    const { runtime, release } = await Runtime.open({
      paths: home(),
      llm,
      onLockLost: (error) => {
        throw error
      },
    })
    await runtime.runUntilIdle(undefined, 10_000)
    await runtime.close()
    await release()
  }
  const request = { id: '1', source: 'cli' as const, thread: 't', text: 'fix it', at }

  it('when the project runs in shadow, its acknowledgement stays unsent', async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: '' })
    writeSpool(home(), request)
    await run(new ScriptedLlm(() => verdict()))
    expect(readStatus(home(), 0)).toMatchObject({ wouldSay: 1, sent: 0 })
    expect(existsSync(home().inbox)).toBe(false)
  })
  it('when the Leader needs to clarify, its question reaches the inbox under the same thread', async () => {
    writeSpool(home(), request)
    await run(new ScriptedLlm(() => verdict({ action: 'clarify', project: null, question: 'Which one?' })))
    expect(readInbox(home()).entries).toMatchObject([{ thread: 'cli:t', text: 'Which one?' }])
    expect(readStatus(home(), 0).sent).toBe(1)
  })
  it('when the Leader ignores a request, nothing reaches the inbox', async () => {
    writeSpool(home(), request)
    await run(new ScriptedLlm(() => verdict({ action: 'ignore', project: null })))
    expect(existsSync(home().inbox)).toBe(false)
  })
  it('the inbox command shows each message once, and --all shows them again', async () => {
    appendInbox(home(), { ...entry('a', 'hello'), thread: 'cli:abc' })
    const lines: string[] = []
    const io = { out: (line: string) => lines.push(line), err: () => {} }
    await main(['inbox'], io, home())
    expect(lines.at(-1)).toContain('[abc] hello')
    await main(['inbox'], io, home())
    expect(lines.at(-1)).toBe('没有新消息')
    await main(['inbox', '--all', '--json'], io, home())
    expect(JSON.parse(lines.at(-1) ?? '[]')).toMatchObject([{ id: 'a' }])
  })
})
