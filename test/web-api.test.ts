import { readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { MAX_TEXT_CHARS } from '../src/config.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { addProject } from '../src/projects.ts'
import { spoolFiles } from '../src/spool.ts'
import { startWebServer, type WebServer } from '../src/web/server.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { useHome } from './helpers.ts'
import { request, type TestResponse } from './web-helpers.ts'

const home = useHome()
const at = (second: number) => `2026-11-04T00:00:${String(second).padStart(2, '0')}.000Z`
let web: WebServer | undefined

afterEach(async () => {
  await web?.close()
  web = undefined
})

function body(response: TestResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>
}

function data(response: TestResponse): Record<string, unknown> {
  expect(response.status).toBe(200)
  expect(body(response)).toMatchObject({ ok: true })
  return (body(response) as { data: Record<string, unknown> }).data
}

function error(response: TestResponse, status: number, code: string): void {
  expect(response.status).toBe(status)
  expect(body(response)).toMatchObject({ ok: false, error: { code } })
}

function saveTrigger(db: Store['db'], id: string, thread: string, time: string, text: string): void {
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

function saveTicket(db: Store['db'], id: string, thread: string, ended = false): void {
  const ticket = {
    id,
    title: `工单 ${id}`,
    decisionId: 'd1',
    mandate: { scope: '演示' },
    channels: [{ source: 'cli', thread, address: {} }],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: at(1),
    updatedAt: at(1),
    origin: { triggerId: 'cli:m1', triggerIds: ['cli:m1'] },
    ...(ended ? { ended: { at: at(2), by: 'human', outcome: 'stopped' } } : {}),
  }
  db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(id, JSON.stringify(ticket))
}

function seedMemory(id: string, time: string, text: string, scope = 'global', pinned = false): void {
  const memory = new MemoryStore(home().memory)
  try {
    memory.record({ id, at: time, origin: 'human', scope, pinned, body: text })
  } finally {
    memory.close()
  }
}

async function started(): Promise<WebServer> {
  web = await startWebServer({ paths: home(), port: 0 })
  return web
}

async function post(path: string, value: unknown, extra: Record<string, string> = {}): Promise<TestResponse> {
  const server = web ?? (await started())
  return request(server, {
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(value),
  })
}

describe('web overview API', () => {
  it('shows the runner, status and only the public project fields', async () => {
    addProject(home().projects, { id: 'demo', path: home().home, brief: '内部简介', execute: true })
    const server = await started()

    const response = await request(server)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(body(response)).toMatchObject({
      ok: true,
      data: {
        runnerUp: false,
        status: { spoolWaiting: 0, triggers: 0, tickets: 0 },
        projects: [{ id: 'demo', execute: true }],
      },
    })
    expect(response.body).not.toContain('内部简介')
    expect(response.body).not.toContain(home().home)
  })

  it('gives every start a fresh token in the URL fragment and closes cleanly', async () => {
    const first = await startWebServer({ paths: home(), port: 0 })
    const second = await startWebServer({ paths: home(), port: 0 })
    try {
      expect(first.token).toMatch(/^[a-f0-9]{64}$/)
      expect(first.token).not.toBe(second.token)
      expect(first.url).toBe(`http://127.0.0.1:${first.address.port}/#token=${first.token}`)
    } finally {
      await first.close()
      await second.close()
    }
    await expect(request(first)).rejects.toThrow()
  })
})

describe('web conversation API', () => {
  it('lists threads newest first and honors the limit', async () => {
    const store = new Store(home().db)
    try {
      saveTrigger(store.db, 'cli:a1', 'cli:a', at(1), '旧话题')
      saveTrigger(store.db, 'cli:b1', 'cli:b', at(2), '新话题')
    } finally {
      store.close()
    }
    const server = await started()
    const response = await request(server, { path: '/api/threads?limit=1' })
    expect(data(response)).toMatchObject({ threads: [{ key: 'cli:b', preview: '新话题', messageCount: 1 }] })

    error(await request(server, { path: '/api/threads?limit=0' }), 400, 'E_BAD_REQUEST')
    error(await request(server, { path: '/api/threads?limit=101' }), 400, 'E_BAD_REQUEST')
  })

  it('reads one encoded thread with Chinese text and newest-limit behavior', async () => {
    const store = new Store(home().db)
    try {
      saveTrigger(store.db, 'cli:m1', 'cli:工作', at(1), '第一句')
      saveTrigger(store.db, 'cli:m2', 'cli:工作', at(2), '第二句')
    } finally {
      store.close()
    }
    const server = await started()
    const key = encodeURIComponent('cli:工作')
    const response = await request(server, { path: `/api/threads/${key}/messages?limit=1` })
    expect(data(response)).toMatchObject({ messages: [{ id: 'cli:m2', text: '第二句', state: 'received' }] })
    error(await request(server, { path: `/api/threads/${key}/messages?limit=101` }), 400, 'E_BAD_REQUEST')
  })

  it('submits Chinese and multi-line messages through the same queue as the CLI', async () => {
    await started()
    const text = '给 demo 加一个 add 函数\n保留换行'
    const response = await post('/api/messages', { text, thread: 'work' })
    const result = data(response)
    expect(result).toMatchObject({ threadKey: 'cli:work' })
    expect(result.triggerId).toMatch(/^cli:/)
    const [name] = spoolFiles(home())
    expect(JSON.parse(readFileSync(join(home().spool, name ?? ''), 'utf8'))).toMatchObject({
      source: 'cli',
      thread: 'work',
      text,
    })
  })

  it('refuses bad message input and replay threads', async () => {
    await started()
    error(await post('/api/messages', { text: '   ' }), 400, 'E_BAD_REQUEST')
    error(await post('/api/messages', { text: 'x'.repeat(MAX_TEXT_CHARS + 1) }), 400, 'E_BAD_REQUEST')
    error(await post('/api/messages', { text: 'hi', extra: true }), 400, 'E_BAD_REQUEST')
    error(await post('/api/messages', { text: 'hi', thread: 'replay:old' }), 409, 'E_CONFLICT')
  })
})

describe('web ticket API', () => {
  it('lists tickets with their thread and submits a full-id stop', async () => {
    const store = new Store(home().db)
    try {
      saveTicket(store.db, 'ticket-open', 'cli:work')
      saveTicket(store.db, 'ticket-ended', 'cli:old', true)
    } finally {
      store.close()
    }
    const server = await started()
    const listed = data(await request(server, { path: '/api/tickets' }))
    expect(listed.tickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ticket-open', threadKey: 'cli:work', stage: 'working' }),
        expect.objectContaining({ id: 'ticket-ended', threadKey: 'cli:old', stage: 'ended' }),
      ]),
    )

    const stopped = await post('/api/tickets/ticket-open/stop', { reason: '不要了' })
    expect(data(stopped)).toEqual({ ticketId: 'ticket-open' })
    const [name] = spoolFiles(home())
    expect(JSON.parse(readFileSync(join(home().spool, name ?? ''), 'utf8'))).toEqual({
      command: 'stop',
      ticketId: 'ticket-open',
      reason: '不要了',
    })
  })

  it('refuses a missing, prefix, ended or invalid stop request', async () => {
    const store = new Store(home().db)
    try {
      saveTicket(store.db, 'ticket-open', 'cli:work')
      saveTicket(store.db, 'ticket-ended', 'cli:old', true)
    } finally {
      store.close()
    }
    await started()
    error(await post('/api/tickets/missing/stop', {}), 404, 'E_NOT_FOUND')
    error(await post('/api/tickets/ticket/stop', {}), 404, 'E_NOT_FOUND')
    error(await post('/api/tickets/ticket-ended/stop', {}), 409, 'E_CONFLICT')
    error(await post('/api/tickets/ticket-open/stop', { reason: 'x', extra: true }), 400, 'E_BAD_REQUEST')
    error(await post('/api/tickets/ticket-open/stop', { reason: 'x'.repeat(MAX_TEXT_CHARS + 1) }), 400, 'E_BAD_REQUEST')
  })
})

describe('web memory API', () => {
  it('lists, searches Chinese two-character words and filters by project', async () => {
    addProject(home().projects, { id: 'demo', path: home().home, brief: '' })
    seedMemory('m1', at(1), '登录要记日志')
    seedMemory('m2', at(2), '登录项目规则', 'project:demo', true)
    seedMemory('m3', at(3), '别的规则', 'project:other', true)
    const server = await started()

    const search = data(await request(server, { path: '/api/memory?q=%E7%99%BB%E5%BD%95' }))
    expect(search.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'm1' }), expect.objectContaining({ id: 'm2' })]),
    )
    expect(JSON.stringify(search)).not.toContain('m3')

    const scoped = data(await request(server, { path: '/api/memory?q=%E7%99%BB%E5%BD%95&project=demo' }))
    expect(scoped.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'm1' }), expect.objectContaining({ id: 'm2' })]),
    )

    const latest = data(await request(server, { path: '/api/memory?limit=1' }))
    expect(latest).toMatchObject({ entries: [{ id: 'm3' }] })
    error(await request(server, { path: '/api/memory?limit=101' }), 400, 'E_BAD_REQUEST')
  })

  it('shows an id containing a colon and preserves long Chinese text', async () => {
    const long = '记住这段中文'.repeat(1000)
    seedMemory('fact:one', at(1), long)
    const server = await started()
    const response = await request(server, { path: `/api/memory/${encodeURIComponent('fact:one')}` })
    expect(data(response)).toMatchObject({ entry: { id: 'fact:one', body: long } })
    error(await request(server, { path: '/api/memory/missing' }), 404, 'E_NOT_FOUND')
  })

  it('creates, supersedes and forgets while refusing unknown ids and projects', async () => {
    addProject(home().projects, { id: 'demo', path: home().home, brief: '' })
    const server = await started()
    const created = data(await post('/api/memory', { text: '网页记下的规则', project: 'demo' }))
    const id = String(created.id)
    expect(id).toMatch(/^remember-/)

    const shown = data(await request(server, { path: `/api/memory/${encodeURIComponent(id)}` }))
    expect(shown).toMatchObject({ entry: { id, body: '网页记下的规则', scope: 'project:demo' } })

    const replacement = data(await post('/api/memory', { text: '新规则', project: 'demo', supersedes: id }))
    expect(replacement.id).toMatch(/^remember-/)
    expect(data(await request(server, { path: '/api/memory?project=demo' }))).toMatchObject({
      entries: [{ id: replacement.id, body: '新规则' }],
    })

    expect(data(await post(`/api/memory/${encodeURIComponent(id)}/forget`, { reason: '不需要了' }))).toEqual({ id })
    error(await request(server, { path: `/api/memory/${encodeURIComponent(id)}` }), 404, 'E_NOT_FOUND')
    error(await post('/api/memory', { text: '规则', project: 'ghost' }), 404, 'E_NOT_FOUND')
    error(await post('/api/memory', { text: '规则', supersedes: 'missing' }), 404, 'E_NOT_FOUND')
    error(await post('/api/memory/missing/forget', {}), 404, 'E_NOT_FOUND')
    error(await post('/api/memory', { text: 'x'.repeat(MAX_TEXT_CHARS + 1) }), 400, 'E_BAD_REQUEST')
  })
})

describe('resident web command', () => {
  it('explains how to choose another port when the requested one is taken', async () => {
    const occupied = createNetServer()
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const errors: string[] = []
    try {
      await expect(
        main(['web', '--port', String(port)], { out: () => {}, err: (line) => errors.push(line) }, home()),
      ).resolves.toBe(1)
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())))
    }
    expect(errors.join('\n')).toContain('端口')
    expect(errors.join('\n')).toContain('--port')
  })

  it('refuses a port that is not a whole number in range', async () => {
    const errors: string[] = []
    for (const value of ['abc', '-1', '70000']) {
      await expect(
        main(['web', '--port', value], { out: () => {}, err: (line) => errors.push(line) }, home()),
      ).resolves.toBe(1)
    }
    expect(errors.join('\n')).toContain('端口')
  })
})
