import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lock } from 'proper-lockfile'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCK_STALE_MS } from '../src/config.ts'
import { listThreads, readThread } from '../src/conversations.ts'
import { appendInbox, takeUnread } from '../src/inbox.ts'
import { isRunnerUp } from '../src/runner-state.ts'
import { pendingSpoolItems, writeSpool, writeSpoolCommand } from '../src/spool.ts'
import { readTickets } from '../src/tickets-view.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { useHome } from './helpers.ts'

const home = useHome()
const at = (second: number) => `2026-11-04T00:00:${String(second).padStart(2, '0')}.000Z`

afterEach(() => {
  vi.restoreAllMocks()
})

function store(): Store {
  return new Store(home().db)
}

function saveTrigger(db: DatabaseSync, id: string, thread: string, time: string, text: string): void {
  const trigger = {
    id,
    source: 'cli',
    threads: [{ source: 'cli', id: thread.slice('cli:'.length) }],
    actor: { source: 'cli', id: 'owner' },
    human: true,
    addressed: 'direct',
    at: time,
    text,
    channel: { source: 'cli', thread, address: {} },
    meta: {},
  }
  db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)').run(id, JSON.stringify(trigger), time)
  db.prepare('INSERT INTO trigger_thread (thread, id, at, human) VALUES (?, ?, ?, 1)').run(thread, id, time)
}

function saveDecision(
  db: DatabaseSync,
  id: string,
  thread: string,
  triggerIds: string[],
  time: string,
  kind = 'accept',
  audit: Record<string, unknown> = { project: 'demo' },
): void {
  const decision = {
    id,
    evalId: `eval-${id}`,
    threadKey: thread,
    triggerIds,
    policyVersion: '1',
    at: time,
    kind,
    reason: [],
    strength: 'explicit',
    audit,
  }
  db.prepare('INSERT INTO decision (id, thread, value) VALUES (?, ?, ?)').run(id, thread, JSON.stringify(decision))
}

function saveTicket(db: DatabaseSync, id: string, thread: string): void {
  const ticket = {
    id,
    title: '演示工单',
    decisionId: 'd1',
    mandate: { scope: '演示' },
    channels: [{ source: 'cli', thread, address: {} }],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: at(1),
    updatedAt: at(1),
    origin: { triggerId: 'cli:m1', triggerIds: ['cli:m1'] },
  }
  db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(id, JSON.stringify(ticket))
}

describe('conversation views', () => {
  it('merges received, queued and Leader messages oldest first with their judgement state', () => {
    const db = store()
    try {
      saveTrigger(db.db, 'cli:m1', 'cli:work', at(1), '第一句')
      saveTrigger(db.db, 'cli:m2', 'cli:work', at(2), '第二句')
      saveDecision(db.db, 'd1', 'cli:work', ['cli:m1'], at(2), 'accept', { project: 'demo' })
    } finally {
      db.close()
    }
    writeSpool(home(), { id: 'm3', source: 'cli', thread: 'work', text: '第三句', at: at(3) })
    appendInbox(home(), { id: 'i1', at: at(4), thread: 'cli:work', kind: 'reply', text: '收到' })

    expect(readThread(home(), 'cli:work', 100)).toMatchObject([
      { role: 'user', id: 'cli:m1', text: '第一句', state: 'decided', outcome: 'demo' },
      { role: 'user', id: 'cli:m2', text: '第二句', state: 'received' },
      { role: 'user', id: 'cli:m3', text: '第三句', state: 'queued' },
      { role: 'leader', id: 'i1', text: '收到', kind: 'reply' },
    ])
  })

  it('shows one message when a queued item has also been received, preferring the received copy', () => {
    const db = store()
    try {
      saveTrigger(db.db, 'cli:m1', 'cli:work', at(1), '同一句')
    } finally {
      db.close()
    }
    writeSpool(home(), { id: 'm1', source: 'cli', thread: 'work', text: '同一句', at: at(1) })

    expect(readThread(home(), 'cli:work', 100)).toMatchObject([{ role: 'user', id: 'cli:m1', state: 'received' }])
  })

  it('returns empty without a database, while queued messages still create and fill their thread', () => {
    expect(readThread(home(), 'cli:work', 100)).toEqual([])
    expect(listThreads(home(), 100)).toEqual([])

    writeSpool(home(), { id: 'm1', source: 'cli', thread: 'work', text: '排队中的请求', at: at(1) })

    expect(readThread(home(), 'cli:work', 100)).toMatchObject([{ role: 'user', id: 'cli:m1', state: 'queued' }])
    expect(listThreads(home(), 100)).toMatchObject([
      { key: 'cli:work', lastAt: at(1), preview: '排队中的请求', messageCount: 1 },
    ])
  })

  it('lists database threads newest first and adds a thread that exists only in the queue', () => {
    const db = store()
    try {
      saveTrigger(db.db, 'cli:a1', 'cli:a', at(1), '甲一')
      saveTrigger(db.db, 'cli:a2', 'cli:a', at(2), '甲二')
      saveTrigger(db.db, 'cli:b1', 'cli:b', at(2), '乙一')
    } finally {
      db.close()
    }
    writeSpool(home(), { id: 'c1', source: 'cli', thread: 'c', text: '丙一', at: at(3) })

    expect(listThreads(home(), 100)).toMatchObject([
      { key: 'cli:c', preview: '丙一', messageCount: 1 },
      { key: 'cli:a', preview: '甲二', messageCount: 2 },
      { key: 'cli:b', preview: '乙一', messageCount: 1 },
    ])
  })

  it('keeps CLI unread state untouched when the panel reads a thread', () => {
    appendInbox(home(), { id: 'i1', at: at(1), thread: 'cli:work', kind: 'reply', text: '未读回复' })
    expect(readThread(home(), 'cli:work', 100)).toHaveLength(1)
    expect(existsSync(home().inboxRead)).toBe(false)
    expect(takeUnread(home())).toMatchObject([{ id: 'i1', text: '未读回复' }])
  })

  it('reads pending items without moving or changing malformed files or commands', () => {
    mkdirSync(home().spool, { recursive: true })
    writeFileSync(join(home().spool, 'bad.json'), '{not json')
    writeSpoolCommand(home(), { command: 'stop', ticketId: 't' })
    writeSpool(home(), { id: 'm1', source: 'cli', thread: 'work', text: '有效', at: at(1) })

    expect(pendingSpoolItems(home()).map((item) => item.id)).toEqual(['m1'])
    expect(existsSync(join(home().spool, 'bad.json'))).toBe(true)
    expect(readFileSync(join(home().spool, 'bad.json'), 'utf8')).toBe('{not json')
  })

  it('does constant database work as a thread grows', () => {
    const db = store()
    try {
      saveTrigger(db.db, 'cli:m1', 'cli:work', at(1), '一')
      for (let index = 2; index <= 40; index++) {
        saveTrigger(db.db, `cli:m${index}`, 'cli:work', at(index % 60), `第 ${index} 句`)
      }
    } finally {
      db.close()
    }
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    prepare.mockClear()
    readThread(home(), 'cli:work', 100)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('gives each ticket row the thread its answer belongs to', () => {
    const db = store()
    try {
      saveTicket(db.db, 't1', 'cli:work')
    } finally {
      db.close()
    }
    expect(readTickets(home())).toMatchObject([{ id: 't1', threadKey: 'cli:work' }])
  })
})

describe('runner state', () => {
  it('is down before the state directory exists and up only while its lock is held', async () => {
    expect(await isRunnerUp(home())).toBe(false)
    mkdirSync(home().home, { recursive: true })
    const release = await lock(home().home, { lockfilePath: home().lock, stale: LOCK_STALE_MS })
    try {
      expect(await isRunnerUp(home())).toBe(true)
    } finally {
      await release()
    }
    expect(await isRunnerUp(home())).toBe(false)
  })
})
