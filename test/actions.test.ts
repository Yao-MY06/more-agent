import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ActionError, forgetEntry, rememberRule, submitMessage, submitStop } from '../src/actions.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { addProject } from '../src/projects.ts'
import { spoolFiles } from '../src/spool.ts'
import { useHome } from './helpers.ts'

const home = useHome()
const at = '2026-11-04T00:00:00.000Z'

function firstSpoolEntry(): unknown {
  const [name] = spoolFiles(home())
  if (!name) throw new Error('No spool entry was written')
  return JSON.parse(readFileSync(join(home().spool, name), 'utf8'))
}

function actionError(run: () => unknown): ActionError {
  try {
    run()
  } catch (error) {
    if (error instanceof ActionError) return error
    throw error
  }
  throw new Error('Expected an ActionError')
}

function seedTicket(id: string, ended = false): void {
  const ticket = {
    id,
    title: '演示工单',
    decisionId: 'd1',
    channels: [{ source: 'cli', thread: 'cli:work', address: {} }],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: at,
    updatedAt: at,
    origin: { triggerId: 'cli:1', triggerIds: ['cli:1'] },
    ...(ended ? { ended: { at, by: 'human', outcome: 'stopped' } } : {}),
  }
  const db = new DatabaseSync(home().db)
  try {
    db.exec(
      'CREATE TABLE ticket (value TEXT NOT NULL); CREATE TABLE decision (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    )
    db.prepare('INSERT INTO ticket (value) VALUES (?)').run(JSON.stringify(ticket))
  } finally {
    db.close()
  }
}

describe('shared write actions', () => {
  it('submits a new message into its own thread and returns both keys', () => {
    const result = submitMessage(home(), { text: '给 demo 加一个 add 函数' })
    expect(result.triggerId).toMatch(/^cli:/)
    expect(result.threadKey).toBe(result.triggerId)
    expect(firstSpoolEntry()).toMatchObject({ source: 'cli', text: '给 demo 加一个 add 函数' })
  })

  it('submits a follow-up on the thread the person named', () => {
    const result = submitMessage(home(), { text: '继续', thread: 'work' })
    expect(result.threadKey).toBe('cli:work')
    expect(firstSpoolEntry()).toMatchObject({ source: 'cli', thread: 'work', text: '继续' })
  })

  it('refuses a stop for a missing ticket or a prefix rather than a full id', () => {
    seedTicket('ticket-full')
    expect(actionError(() => submitStop(home(), { ticketId: 'ticket' })).code).toBe('E_NOT_FOUND')
    expect(actionError(() => submitStop(home(), { ticketId: 'missing' })).code).toBe('E_NOT_FOUND')
  })

  it('refuses a stop after the ticket has ended', () => {
    seedTicket('ticket-ended', true)
    expect(actionError(() => submitStop(home(), { ticketId: 'ticket-ended' })).code).toBe('E_CONFLICT')
  })

  it('submits a stop with its reason for the runner to carry out', () => {
    seedTicket('ticket-open')
    expect(submitStop(home(), { ticketId: 'ticket-open', reason: '不要了' })).toEqual({ ticketId: 'ticket-open' })
    expect(firstSpoolEntry()).toEqual({ command: 'stop', ticketId: 'ticket-open', reason: '不要了' })
  })

  it('remembers a rule globally and refuses an unknown project or superseded rule', () => {
    const memory = new MemoryStore(home().memory)
    try {
      const { id } = rememberRule(home(), memory, { text: '登录要记日志' })
      expect(memory.get(id)).toMatchObject({ body: '登录要记日志', scope: 'global', pinned: true })
      expect(actionError(() => rememberRule(home(), memory, { text: '规则', project: 'ghost' })).code).toBe(
        'E_NOT_FOUND',
      )
      expect(actionError(() => rememberRule(home(), memory, { text: '规则', supersedes: 'missing' })).code).toBe(
        'E_NOT_FOUND',
      )
    } finally {
      memory.close()
    }
  })

  it('remembers a project rule and can supersede a rule that exists', () => {
    addProject(home().projects, { id: 'demo', path: home().home, brief: '' })
    const memory = new MemoryStore(home().memory)
    try {
      const first = rememberRule(home(), memory, { text: '旧规则', project: 'demo' })
      const second = rememberRule(home(), memory, { text: '新规则', project: 'demo', supersedes: first.id })
      expect(memory.get(first.id)?.supersededBy).toBe(second.id)
      expect(memory.list()).toMatchObject([{ id: second.id, body: '新规则', scope: 'project:demo' }])
    } finally {
      memory.close()
    }
  })

  it('forgets an existing rule without erasing its words', () => {
    const memory = new MemoryStore(home().memory)
    try {
      const { id } = rememberRule(home(), memory, { text: '这条要作废' })
      expect(forgetEntry(memory, { id, reason: '不需要了' })).toEqual({ id })
      expect(memory.get(id)?.supersededBy).toBe(`forget-${id}`)
      expect(memory.get(`forget-${id}`)).toMatchObject({ retires: true, body: '不需要了' })
      expect(actionError(() => forgetEntry(memory, { id: 'missing' })).code).toBe('E_NOT_FOUND')
    } finally {
      memory.close()
    }
  })
})
