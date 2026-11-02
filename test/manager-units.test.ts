import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { managerSettings, projectRoot } from '../src/config.ts'
import { LeaderReporter, RELAY_COST, REPORTER_SYSTEM_PROMPT } from '../src/leader/reporter.ts'
import type { Llm } from '../src/llm/llm.ts'
import { managerArguments, sessionIdFor } from '../src/manager/args.ts'
import { killWorkers, runningTickets } from '../src/manager/omh.ts'
import { loadManagerSkill, managerSystemPrompt, turnCard } from '../src/manager/prompt.ts'
import { managerReportJsonSchema, parseManagerReport, parseTurnOutcome } from '../src/manager/report.ts'
import type { TurnView } from '../src/manager/turn.ts'
import { LocalOutbox } from '../src/outbox.ts'
import { localPolicy, localScope } from '../src/policy.ts'
import { toTrigger } from '../src/spool.ts'
import { ticketExecutes } from '../src/ticket-project.ts'
import { Effects } from '../vendor/dsh-superagent/src/app/effects.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { Engine, type Ticket } from '../vendor/dsh-superagent/src/core/index.ts'
import { HealthBoard } from '../vendor/dsh-superagent/src/infra/health.ts'
import { usage, useHome } from './helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_OMH = join(HERE, 'fixtures', 'fake-omh.mjs')
const REAL_OMH = join(HERE, '..', '..', 'opus-manager', 'harness', 'bin', 'omh.js')
const OLD_ENOUGH_MS = 10 * 60_000
/** Starting real processes takes seconds when the whole suite runs at once. */
const REAL_PROCESS_TIMEOUT_MS = 30_000

const home = useHome()
const report = (overrides = {}) => ({
  state: 'ready',
  summary: 's',
  question: null,
  wait_for: [],
  followups: [],
  ...overrides,
})
const view = (overrides: Partial<TurnView> = {}): TurnView => ({
  phase: 'finished',
  state: 'exited',
  exitCode: 0,
  stdout: '',
  stderr: '',
  ...overrides,
})
const claudeResult = (structured: unknown, extra = {}) =>
  JSON.stringify({ structured_output: structured, total_cost_usd: 0.2, ...extra })

describe('manager report rules', () => {
  it('accepts a report that follows its state rule', () => {
    expect(parseManagerReport(report()).state).toBe('ready')
    expect(parseManagerReport(report({ state: 'waiting', wait_for: ['T1'] })).wait_for).toEqual(['T1'])
    expect(parseManagerReport(report({ state: 'blocked', question: '哪个？' })).question).toBe('哪个？')
  })
  it('refuses a blocked report with no question, a waiting one with no tickets, and a question on any other state', () => {
    expect(() => parseManagerReport(report({ state: 'blocked' }))).toThrow('question')
    expect(() => parseManagerReport(report({ state: 'waiting' }))).toThrow('omh tickets')
    expect(() => parseManagerReport(report({ question: '多余' }))).toThrow('cannot ask')
  })
  it('refuses an omh ticket id that is not one, so it cannot reach a command line', () => {
    expect(() => parseManagerReport(report({ state: 'waiting', wait_for: ['T1; rm -rf /'] }))).toThrow()
  })
  it('publishes a schema with every field and no dialect marker', () => {
    const schema = managerReportJsonSchema() as { required: string[]; $schema?: string }
    expect(schema.$schema).toBeUndefined()
    expect(schema.required).toEqual(expect.arrayContaining(['state', 'summary', 'question', 'wait_for', 'followups']))
  })
})

describe('reading a finished turn', () => {
  it('gives the report and its usage when all is well', () => {
    const outcome = parseTurnOutcome(view({ stdout: claudeResult(report()) }))
    expect(outcome).toMatchObject({ kind: 'report', report: { state: 'ready' }, sessionTotalUsd: 0.2 })
  })
  it('tells a killed turn apart, whatever it printed', () => {
    expect(parseTurnOutcome(view({ state: 'killed' })).kind).toBe('killed')
  })
  it('spots a lost session on either stream', () => {
    expect(parseTurnOutcome(view({ stderr: 'No conversation found with session ID x', exitCode: 1 })).kind).toBe(
      'session-lost',
    )
    expect(parseTurnOutcome(view({ stdout: 'No conversation found', exitCode: 1 })).kind).toBe('session-lost')
  })
  it('says why when the turn timed out or never started', () => {
    expect(parseTurnOutcome(view({ state: 'timeout' }))).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('硬超时'),
    })
    expect(parseTurnOutcome(view({ state: 'failed-to-start', error: 'ENOENT' }))).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('ENOENT'),
    })
  })
  it('keeps the cost of a report that broke the rules, since it was still spent', () => {
    expect(parseTurnOutcome(view({ stdout: claudeResult(report({ state: 'blocked' })) }))).toMatchObject({
      kind: 'failure',
      sessionTotalUsd: 0.2,
    })
  })
  it('says in plain words when the CLI stopped for its budget, whatever the exit code, and keeps what it cost', () => {
    const stdout = JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 3.1 })
    for (const exitCode of [0, 1]) {
      expect(parseTurnOutcome(view({ stdout, exitCode }))).toEqual({
        kind: 'failure',
        reason: '这一轮用完了预算上限',
        sessionTotalUsd: 3.1,
      })
    }
  })
  it('passes on what the CLI said about any other failure', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'API overloaded' })
    expect(parseTurnOutcome(view({ stdout, exitCode: 1 }))).toMatchObject({
      reason: expect.stringContaining('API overloaded'),
    })
  })
})

describe('manager arguments', () => {
  const settings = { model: 'm', effort: 'high', command: ['claude'], turnBudgetUsd: 3, omh: 'C:/omh.js', skill: 's' }
  const base = { sessionId: 'id', systemPromptFile: 'p.md', schema: {} }
  const argOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

  it('starts a new session the first time and resumes it after', () => {
    expect(argOf(managerArguments(settings, { ...base, resume: false }), '--session-id')).toBe('id')
    const resumed = managerArguments(settings, { ...base, resume: true })
    expect(argOf(resumed, '--resume')).toBe('id')
    expect(resumed).not.toContain('--session-id')
  })
  it('connects only omh, and ignores user settings and other MCP servers', () => {
    const args = managerArguments(settings, { ...base, resume: false })
    expect(args).toContain('--strict-mcp-config')
    expect(argOf(args, '--setting-sources')).toBe('project,local')
    expect(Object.keys(JSON.parse(argOf(args, '--mcp-config') ?? '{}').mcpServers)).toEqual(['omh'])
  })
  it('allows writing only under _tickets', () => {
    const allowed = argOf(managerArguments(settings, { ...base, resume: false }), '--allowedTools')?.split(',') ?? []
    expect(allowed.filter((tool) => tool.startsWith('Edit') || tool.startsWith('Write'))).toEqual([
      'Edit(_tickets/**)',
      'Write(_tickets/**)',
    ])
  })
  it('derives a valid UUID, the same for the same Ticket and different for another', () => {
    expect(sessionIdFor('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sessionIdFor('a')).toBe(sessionIdFor('a'))
    expect(sessionIdFor('a')).not.toBe(sessionIdFor('b'))
  })
})

describe('manager prompt', () => {
  it('takes the ticket workflow from the skill and leaves its setup and unattended sections out', () => {
    const skill = loadManagerSkill(join(HERE, 'fixtures', 'skill.md'))
    expect(skill).toContain('SKILL-BODY-MARKER')
    expect(skill).not.toContain('安装说明')
    expect(skill).not.toContain('不适用的部分')
    expect(managerSystemPrompt(skill)).toContain('你没有 Bash')
  })
  it('refuses a skill file whose sections moved, rather than instruct a manager with half of it', () => {
    const file = join(home().home, 'skill.md')
    writeFileSync(file, '# nothing here')
    expect(() => loadManagerSkill(file)).toThrow('changed shape')
  })
  it.runIf(existsSync(REAL_OMH))('reads the real opus-manager skill', () => {
    const skill = loadManagerSkill(managerSettings({}).skill)
    expect(skill).toContain('写工单')
    expect(skill).toContain('收尾')
    expect(skill).not.toContain('无人托管')
  })
  it('shows only the Inputs of this turn, and the request only when the work is new', () => {
    const ticket = {
      title: 'T',
      mandate: { scope: 'S' },
      origin: { triggerIds: ['cli:1'] },
      inputs: [
        { id: 'i1', kind: 'trigger', triggerId: 'cli:2', at: '' },
        { id: 'i2', kind: 'trigger', triggerId: 'cli:3', at: '' },
        { id: 'i3', kind: 'text', text: 'note', at: '' },
        { id: 'i4', kind: 'resumed', triggerId: 'cli:3', at: '' },
        { id: 'i5', kind: 'policy-changed', from: 'a', to: 'b', at: '' },
      ],
    } as unknown as Ticket
    const trigger = (id: string) =>
      toTrigger({ id: id.slice(4), source: 'cli', thread: 't', text: `text ${id}`, at: '2026-11-02T00:00:00.000Z' })
    const later = JSON.parse(turnCard(ticket, { kind: 'inputs' }, ['i2', 'i3', 'i4', 'i5'], trigger))
    expect(later.request).toBeUndefined()
    expect(later.inputs.map((input: { kind: string }) => input.kind)).toEqual(['message', 'note', 'resumed'])
    const first = JSON.parse(turnCard(ticket, { kind: 'assignment' }, [], trigger))
    expect(first).toMatchObject({ title: 'T', scope: 'S', request: ['text cli:1'], inputs: [] })
  })
})

describe('manager settings', () => {
  it('defaults to Opus 5.5 at medium effort, and finds opus-manager beside this project', () => {
    const settings = managerSettings({})
    expect(settings).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
      command: ['claude'],
      turnBudgetUsd: 3,
    })
    expect(settings.omh.replaceAll('\\', '/')).toContain('opus-manager/harness/bin/omh.js')
  })
  it('takes overrides from the environment', () => {
    const settings = managerSettings({
      RESIDENT_MANAGER_MODEL: 'x',
      RESIDENT_MANAGER_EFFORT: 'low',
      RESIDENT_MANAGER_COMMAND: '["node","f.mjs"]',
      RESIDENT_MANAGER_TURN_BUDGET_USD: '1.5',
      RESIDENT_OMH: 'C:/o.js',
      RESIDENT_MANAGER_SKILL: 'C:/s.md',
    })
    expect(settings).toMatchObject({ model: 'x', effort: 'low', command: ['node', 'f.mjs'], turnBudgetUsd: 1.5 })
    expect(settings.omh.replaceAll('\\', '/')).toBe('C:/o.js')
  })
  it('finds the project root from anywhere inside it, and refuses outside it', () => {
    expect(existsSync(join(projectRoot(HERE), 'package.json'))).toBe(true)
    expect(() => projectRoot(dirname(projectRoot(HERE)))).toThrow('Cannot find')
  })
})

describe('talking to omh', () => {
  it('lists running tickets once each', async () => {
    writeFileSync(join(home().home, 'fake-omh-running.json'), '["T1","T2"]')
    await expect(runningTickets(FAKE_OMH, home().home)).resolves.toEqual(['T1', 'T2'])
  })
  it('kills every running ticket', async () => {
    writeFileSync(join(home().home, 'fake-omh-running.json'), '["T1","T2"]')
    await expect(killWorkers(FAKE_OMH, home().home, 'stopped')).resolves.toEqual([])
    await expect(runningTickets(FAKE_OMH, home().home)).resolves.toEqual([])
  })
  it('fails when omh cannot be read, so a caller can tell that from nothing running', async () => {
    await expect(runningTickets(join(home().home, 'missing.js'), home().home)).rejects.toThrow()
  })
  it.runIf(existsSync(REAL_OMH))('reads the status of the real omh', { timeout: REAL_PROCESS_TIMEOUT_MS }, async () => {
    const { spawnSync } = await import('node:child_process')
    const root = join(home().home, 'project')
    mkdirSync(root)
    expect(spawnSync(process.execPath, [REAL_OMH, 'init'], { cwd: root }).status).toBe(0)
    await expect(runningTickets(REAL_OMH, root)).resolves.toEqual([])
  })
})

describe('the Leader passing on a report', () => {
  function harness(llm: Llm) {
    const store = new Store(join(home().home, 'db.sqlite'))
    const effects = new Effects(store, new HealthBoard())
    const outbox = new LocalOutbox({ store, effects, paths: home(), shouldSend: () => true })
    const lifetime = new AbortController().signal
    let engine: Engine
    const reporter = new LeaderReporter({ engine: () => engine, effects, store, outbox, llm, lifetime })
    engine = new Engine({
      repo: store,
      scope: localScope,
      policy: localPolicy,
      assessor: { request: () => {} },
      executor: { start: () => {}, deliver: () => {}, stop: () => {} },
      outbox,
    })
    engine.receive(toTrigger({ id: '1', source: 'cli', thread: 't', text: '请求原文', at: '2026-11-02T00:00:00.000Z' }))
    engine.evaluateDue()
    const decision = engine.decide('cli:1', { kind: 'accept', title: 'T', scope: 'S', reason: 'R' })
    const ticketId = decision.ticketId ?? ''
    effects.start()
    return { store, effects, outbox, engine, reporter, ticketId }
  }
  const says = (text: string): Llm => ({ complete: async () => ({ output: { text }, usage }) })

  it('sends the words the Leader chose, shows it the request, and records what the call cost', async () => {
    const seen: string[] = []
    const llm: Llm = {
      complete: async (request) => {
        seen.push(request.system, request.user)
        return { output: { text: '做好了' }, usage }
      },
    }
    const { store, effects, engine, reporter, ticketId } = harness(llm)
    engine.report(ticketId, { state: 'ready', summary: '详细汇报' })
    reporter.request({ ticketId, state: 'ready', summary: '详细汇报' })
    await effects.idle()
    expect(seen[0]).toBe(REPORTER_SYSTEM_PROMPT)
    expect(JSON.parse(seen[1] ?? '{}')).toMatchObject({ request: '请求原文', summary: '详细汇报', question: null })
    expect(store.receipts.waiting()).toEqual([])
    expect(store.get(RELAY_COST)).toBe(usage.costUsd)
    await effects.drain()
    store.close()
  })
  it('drops a question that was answered or replaced while it waited', async () => {
    const calls: unknown[] = []
    const llm: Llm = {
      complete: async (request) => {
        calls.push(request)
        return { output: { text: 'x' }, usage }
      },
    }
    const { store, effects, reporter, ticketId } = harness(llm)
    reporter.request({ ticketId, state: 'blocked', summary: 's', question: '旧问题' })
    await effects.idle()
    expect(calls).toEqual([])
    await effects.drain()
    store.close()
  })
  it('falls back to a notice when the Ticket moved on and a result can no longer be sent', async () => {
    const { store, effects, reporter, ticketId } = harness(says('结果'))
    reporter.request({ ticketId, state: 'ready', summary: 's' })
    await effects.idle()
    expect(store.read.search('x')).toEqual([])
    const receipts = store.db
      .prepare('SELECT value FROM outbox')
      .all()
      .map((row) => JSON.parse(String(row.value)))
    expect(receipts).toMatchObject([{ kind: 'notice', text: '结果', status: 'sent' }])
    await effects.drain()
    store.close()
  })
  it('after the Leader has been unavailable too long, the person gets the question in the manager words', async () => {
    const failing: Llm = {
      complete: async () => {
        throw new Error('quota')
      },
    }
    const { store, effects, engine, ticketId } = harness(failing)
    engine.report(ticketId, { state: 'blocked', summary: 's', question: '用哪个？' })
    const since = new Date(Date.now() - OLD_ENOUGH_MS).toISOString()
    const payload = { ticketId, state: 'blocked', summary: 's', question: '用哪个？', since }
    effects.enqueue('relay', 'relay-old', { text: JSON.stringify(payload) })
    await effects.idle()
    const receipts = store.db
      .prepare('SELECT value FROM outbox')
      .all()
      .map((row) => JSON.parse(String(row.value)))
    expect(receipts.map((receipt) => receipt.text)).toEqual(['用哪个？'])
    await effects.drain()
    store.close()
  })
  it('keeps retrying while the Leader has only just become unavailable', async () => {
    const failing: Llm = {
      complete: async () => {
        throw new Error('quota')
      },
    }
    const { store, effects, engine, reporter, ticketId } = harness(failing)
    engine.report(ticketId, { state: 'ready', summary: 's' })
    reporter.request({ ticketId, state: 'ready', summary: 's' })
    await effects.idle()
    expect(effects.pending('relay')).toBe(true)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0)
    await effects.drain()
    store.close()
  })
})

describe('which Tickets execute', () => {
  const project = { id: 'p', path: 'x', brief: '', execute: true }
  const tickets = { get: (id: string) => (id === 't' ? ({ decisionId: 'd' } as Ticket) : undefined) }
  const decisions = (audit: object) => ({ get: () => ({ audit }) as never })

  it('only a known Ticket of a project switched on', () => {
    expect(ticketExecutes('t', tickets, decisions({ project: 'p' }), [project])).toBe(true)
    expect(ticketExecutes('t', tickets, decisions({ project: 'p' }), [{ ...project, execute: false }])).toBe(false)
    expect(ticketExecutes('t', tickets, decisions({ project: 'gone' }), [project])).toBe(false)
    expect(ticketExecutes('other', tickets, decisions({ project: 'p' }), [project])).toBe(false)
    expect(ticketExecutes(undefined, tickets, decisions({ project: 'p' }), [project])).toBe(false)
  })
})
