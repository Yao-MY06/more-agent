/** Memory through the real Runtime: what gets written, what a Leader's card shows, and what its new actions do. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import type { ManagerSettings } from '../src/config.ts'
import { readInbox } from '../src/inbox.ts'
import { memoryScopeOf, parseVerdict, type Verdict } from '../src/leader/verdict.ts'
import type { Llm, LlmRequest, LlmResult } from '../src/llm/llm.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { addProject } from '../src/projects.ts'
import { readStatus, readSummary } from '../src/report.ts'
import { Runtime } from '../src/runtime.ts'
import { writeSpool } from '../src/spool.ts'
import { readTickets } from '../src/tickets-view.ts'
import { usage, useHome, verdict } from './helpers.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const IDLE_LIMIT_MS = 30_000
const TEST_TIMEOUT_MS = 60_000
const LEADER_RULES_SHOWN = 10
const MANAGER_RULES_SHOWN = 20

const home = useHome()
const projectDir = (id = 'demo') => join(home().home, id)
const logFile = () => join(home().home, 'manager.log')

interface Card {
  request: { id: string; text: string }[]
  work: { id: string; title: string; project: string | null; stage: string; outcome?: string }[]
  rules: { id: string; text: string; scope: string }[]
  memory: { id: string; text: string; scope: string; refs?: string[] }[]
  recalled: { id?: string; ref?: string; text?: string; missing?: boolean }[]
  recall_allowed: boolean
}

/** Answers Leader calls from a script of functions that see the card; reports get a fixed wording. */
class CardLeader implements Llm {
  readonly cards: Card[] = []
  private readonly replies: ((card: Card) => Verdict)[]
  constructor(...replies: ((card: Card) => Verdict)[]) {
    this.replies = replies
  }
  async complete(request: LlmRequest): Promise<LlmResult> {
    if (request.system.includes('A project manager has reported')) {
      const card = JSON.parse(request.user)
      return { output: { text: `转述：${card.question ?? card.summary}` }, usage }
    }
    const card = JSON.parse(request.user) as Card
    this.cards.push(card)
    const reply = this.replies.length > 1 ? this.replies.shift() : this.replies[0]
    if (!reply) throw new Error('The script has no reply')
    return { output: reply(card), usage }
  }
}

function managerSettings(): ManagerSettings {
  return {
    model: 'm',
    effort: 'low',
    command: [process.execPath, join(FIXTURES, 'fake-manager.mjs')],
    turnBudgetUsd: 1,
    omh: join(FIXTURES, 'fake-omh.mjs'),
    skill: join(FIXTURES, 'skill.md'),
  }
}

function setup(script: unknown[], execute = true, id = 'demo'): void {
  mkdirSync(join(projectDir(id), '.omh'), { recursive: true })
  writeFileSync(join(projectDir(id), '.omh', 'config.json'), '{}')
  addProject(home().projects, { id, path: projectDir(id), brief: id, execute })
  const file = join(home().home, 'script.json')
  writeFileSync(file, JSON.stringify(script))
  vi.stubEnv('FAKE_MANAGER_SCRIPT', file)
  vi.stubEnv('FAKE_MANAGER_LOG', logFile())
}

let spoolCounter = 0
const say = (id: string, text: string, thread = id) =>
  writeSpool(home(), {
    id,
    source: 'cli',
    thread,
    text,
    at: new Date(Date.now() + ++spoolCounter).toISOString(),
  })

async function run(leader: Llm, memoryEnabled = true): Promise<void> {
  const { runtime, release } = await Runtime.open({
    paths: home(),
    llm: leader,
    manager: managerSettings(),
    memoryEnabled,
    onLockLost: (error) => {
      throw error
    },
  })
  try {
    await runtime.runUntilIdle(undefined, IDLE_LIMIT_MS)
  } finally {
    await runtime.close()
    await release()
  }
}

const memory = () => new MemoryStore(home().memory)
/** Rule 0 is the newest. */
const recordRules = (scope: string, count: number) => {
  const now = Date.now()
  for (let index = 0; index < count; index++) {
    const at = new Date(now - index * 1000).toISOString()
    memory().record({ id: `rule-${index}`, at, origin: 'human', scope, pinned: true, body: `规则 ${index}` })
  }
}
const inboxTexts = () => readInbox(home()).entries.map((entry) => entry.text)
const turns = () =>
  readFileSync(logFile(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; stdin: { memories: { text: string }[]; note: string } })
const ready = { report: { state: 'ready', summary: 'clamp 放在根目录，分支 omh/T1' } }
const route = () => verdict({ project: 'demo', title: 'clamp' })

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('what gets written', { timeout: TEST_TIMEOUT_MS }, () => {
  it('keeps a routed request in the words of the person, under its project, pointing at its Ticket', async () => {
    setup([ready])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const [entry] = memory()
      .search('clamp.js', { scopes: ['project:demo'] })
      .filter((hit) => hit.origin === 'human')
    expect(entry).toMatchObject({ body: '新建 clamp.js', scope: 'project:demo', origin: 'human' })
    expect(entry?.refs).toEqual(expect.arrayContaining(['trigger:cli:1', 'thread:cli:1']))
    expect(entry?.refs?.some((ref) => ref.startsWith('ticket:'))).toBe(true)
  })
  it('keeps what the manager reported, marked as coming from an agent', async () => {
    setup([ready])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const [entry] = memory().search('分支 omh/T1')
    expect(entry).toMatchObject({ origin: 'agent', scope: 'project:demo' })
    expect(entry?.body).toContain('clamp 放在根目录')
  })
  it('keeps a question the manager asked, and the answer given on the thread', async () => {
    setup([
      { report: { state: 'blocked', summary: '两种做法', question: '用 A 还是 B？' } },
      { report: { state: 'ready', summary: '用 A 做完了' }, takeUp: 'taken_up' },
    ])
    say('1', '做这个', 'work')
    await run(new CardLeader(route))
    say('2', '用 A', 'work')
    await run(new CardLeader(route))
    const bodies = memory()
      .list()
      .map((entry) => entry.body)
    expect(bodies.join()).toContain('用 A 还是 B？')
    expect(bodies).toContain('用 A')
  })
  it('leaves out a failed turn: it says nothing worth learning', async () => {
    setup([{ exit: 3, stderr: 'quota exhausted' }])
    say('1', '做这个')
    await run(new CardLeader(route))
    expect(
      memory()
        .list()
        .map((entry) => entry.body)
        .join(),
    ).not.toContain('quota')
  })
  it('leaves out what the Leader ignored', async () => {
    setup([ready])
    say('1', '谢谢')
    await run(new CardLeader(() => verdict({ action: 'ignore', project: null })))
    expect(memory().list()).toEqual([])
  })
  it('remembers a shadow project too: what was said is true whether or not it ran', async () => {
    setup([ready], false)
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    expect(
      memory()
        .list()
        .map((entry) => entry.body),
    ).toEqual(['新建 clamp.js'])
  })
  it('does not write twice when the runner starts again', async () => {
    setup([ready])
    say('1', '新建 clamp.js')
    const leader = new CardLeader(route)
    await run(leader)
    const before = memory().list().length
    await run(leader)
    expect(memory().list()).toHaveLength(before)
  })
})

describe('what a Leader sees', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sees earlier records that match, after a restart, in a new thread', async () => {
    setup([ready])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const leader = new CardLeader(() => verdict({ action: 'answer', project: null, reply: '在根目录' }))
    say('2', 'clamp 放在哪了')
    await run(leader)
    expect(leader.cards[0]?.memory.map((entry) => entry.text).join()).toContain('clamp 放在根目录')
    expect(inboxTexts()).toContain('在根目录')
  })
  it('sees the work on record, including what ended, with its project and outcome', async () => {
    setup([ready])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const leader = new CardLeader(() => verdict({ action: 'ignore', project: null }))
    say('2', '随便说一句')
    await run(leader)
    expect(leader.cards[0]?.work).toMatchObject([{ title: 'clamp', project: 'demo', outcome: 'completed' }])
  })
  it('sees rules even when the request matches none of their words', async () => {
    setup([ready])
    memory().record({
      id: 'r',
      at: new Date().toISOString(),
      origin: 'human',
      scope: 'global',
      pinned: true,
      body: '所有提交都要写中文',
    })
    const leader = new CardLeader(() => verdict({ action: 'ignore', project: null }))
    say('1', '今天如何')
    await run(leader)
    expect(leader.cards[0]?.rules.map((rule) => rule.text)).toEqual(['所有提交都要写中文'])
  })
  it('is told how many older rules did not fit, rather than losing them silently', async () => {
    setup([ready])
    recordRules('global', LEADER_RULES_SHOWN + 2)
    const leader = new CardLeader(() => verdict({ action: 'ignore', project: null }))
    say('1', '今天如何')
    await run(leader)
    expect(leader.cards[0]?.rules).toHaveLength(LEADER_RULES_SHOWN)
    expect(leader.cards[0]?.rules[0]?.text).toBe('规则 0')
    expect(leader.cards[0]).toMatchObject({ rules_omitted: 2 })
  })
  it('is told nothing about omitted rules when they all fit', async () => {
    setup([ready])
    recordRules('global', LEADER_RULES_SHOWN)
    const leader = new CardLeader(() => verdict({ action: 'ignore', project: null }))
    say('1', '今天如何')
    await run(leader)
    expect(leader.cards[0]).not.toHaveProperty('rules_omitted')
  })
  it('does not see the same record twice', async () => {
    setup([ready])
    memory().record({
      id: 'r',
      at: new Date().toISOString(),
      origin: 'human',
      scope: 'global',
      pinned: true,
      body: '规则：登录要记日志',
    })
    const leader = new CardLeader(() => verdict({ action: 'ignore', project: null }))
    say('1', '登录')
    await run(leader)
    expect(leader.cards[0]?.memory.map((entry) => entry.id)).not.toContain('r')
  })
  it('sees a long record cut, told how to read the rest', async () => {
    setup([ready])
    const long = `登录${'很长的内容'.repeat(300)}`
    memory().record({ id: 'long', at: new Date().toISOString(), origin: 'agent', scope: 'global', body: long })
    const leader = new CardLeader(() => verdict({ action: 'ignore', project: null }))
    say('1', '登录')
    await run(leader)
    const [entry] = leader.cards[0]?.memory ?? []
    expect(entry?.text.length).toBeLessThan(long.length)
    expect(entry).toMatchObject({ truncated: expect.stringContaining('memory:long') })
  })
  it('with memory off, sees nothing of the past, though writing goes on', async () => {
    setup([ready])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const leader = new CardLeader(() => verdict({ action: 'ignore', project: null }))
    say('2', 'clamp 放在哪了')
    await run(leader, false)
    expect(leader.cards[0]).toMatchObject({ work: [], rules: [], memory: [], recalled: [], recall_allowed: false })
  })
})

describe('remembering', { timeout: TEST_TIMEOUT_MS }, () => {
  it('keeps the words of the person, not a rewording, and confirms', async () => {
    setup([ready])
    say('1', '记住：demo 的导出都要带 X-MARK-7')
    await run(
      new CardLeader(() => verdict({ action: 'remember', project: 'demo', reply: '记下了', scope: '改写过的内容' })),
    )
    expect(memory().pinned(['project:demo'])).toMatchObject([
      { body: '记住：demo 的导出都要带 X-MARK-7', origin: 'human' },
    ])
    expect(inboxTexts()).toEqual(['记下了'])
    expect(readTickets(home())).toEqual([])
  })
  it('applies everywhere when no project is named', async () => {
    setup([ready])
    say('1', '记住：提交信息都用中文')
    await run(new CardLeader(() => verdict({ action: 'remember', project: null, reply: '记下了' })))
    expect(memory().pinned()[0]?.scope).toBe('global')
  })
  it('replaces an older rule when told to, leaving only the new one in force', async () => {
    setup([ready])
    memory().record({
      id: 'old',
      at: new Date(Date.now() - 1000).toISOString(),
      origin: 'human',
      scope: 'global',
      pinned: true,
      body: '测试用 jest',
    })
    say('1', '记住：测试改用 node:test')
    await run(new CardLeader(() => verdict({ action: 'remember', project: null, reply: '改了', supersedes: 'old' })))
    expect(
      memory()
        .pinned()
        .map((rule) => rule.body),
    ).toEqual(['记住：测试改用 node:test'])
    expect(memory().get('old')?.supersededBy).toBeTruthy()
  })
  it('refuses to replace a record the card did not show', () => {
    const context = { projectIds: [], ticketIds: [], memoryIds: ['shown'], recallAllowed: false }
    const answer = verdict({ action: 'remember', project: null, reply: '好', supersedes: 'hidden' })
    expect(() => parseVerdict(answer, context)).toThrow('did not show')
  })
  it('refuses a project nobody registered, and an empty confirmation', () => {
    const context = { projectIds: ['demo'], ticketIds: [], memoryIds: [], recallAllowed: false }
    expect(() => parseVerdict(verdict({ action: 'remember', project: 'ghost', reply: '好' }), context)).toThrow(
      'unregistered',
    )
    expect(() => parseVerdict(verdict({ action: 'remember', project: null }), context)).toThrow('no reply')
  })
  it('scopes a memory to the project named, or everywhere', () => {
    expect(memoryScopeOf({ project: 'demo' })).toBe('project:demo')
    expect(memoryScopeOf({ project: null })).toBe('global')
  })
})

describe('continuing an old Ticket', { timeout: TEST_TIMEOUT_MS }, () => {
  const attachTo = (card: Card) =>
    verdict({ action: 'attach', project: null, ticket: card.work[0]?.id ?? null, acknowledgement: '接着做' })

  it('resumes the same manager session from another thread, days later in its words', async () => {
    setup([ready, { report: { state: 'ready', summary: '加好了 NaN 处理' }, takeUp: 'taken_up' }])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    say('2', '再给上次那个 clamp 加 NaN 处理')
    await run(new CardLeader(attachTo))
    const [first, second] = turns()
    const session = first?.args[first.args.indexOf('--session-id') + 1]
    expect(second?.args[second.args.indexOf('--resume') + 1]).toBe(session)
    expect(readTickets(home())).toHaveLength(1)
    expect(inboxTexts()).toContain('接着做')
    expect(inboxTexts()).toContain('转述：加好了 NaN 处理')
  })
  it('counts the call and shows it as an attach in the report', async () => {
    setup([ready, { report: { state: 'ready', summary: '好了' }, takeUp: 'taken_up' }])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    say('2', '接着上次的做')
    await run(new CardLeader(attachTo))
    const { summary } = readSummary(home())
    expect(summary).toMatchObject({ attached: 1, routed: 1 })
    expect(summary.costUsd).toBeCloseTo(usage.costUsd * 2)
  })
  it('tells the person when that Ticket was stopped, rather than quietly reviving it', async () => {
    setup([{ report: { state: 'blocked', summary: '等', question: '继续吗？' } }])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const [row] = readTickets(home())
    await main(['stop', row?.id.slice(0, 8) ?? ''], { out: () => {}, err: () => {} }, home())
    await run(new CardLeader(route))
    say('2', '接着上次的做')
    await run(new CardLeader(attachTo))
    expect(inboxTexts().join()).toContain('已经被停止')
    expect(readTickets(home())[0]?.outcome).toBe('stopped')
  })
  it('refuses a Ticket the card did not show', () => {
    const context = { projectIds: [], ticketIds: ['shown'], memoryIds: [], recallAllowed: false }
    const answer = verdict({ action: 'attach', project: null, ticket: 'hidden' })
    expect(() => parseVerdict(answer, context)).toThrow('did not show')
  })
})

describe('recalling', { timeout: TEST_TIMEOUT_MS }, () => {
  const entry = (id: string, body: string) => ({
    id,
    at: new Date().toISOString(),
    origin: 'agent' as const,
    scope: 'global',
    body,
  })

  it('searches again and shows the result, and the answer comes from it', async () => {
    setup([ready])
    memory().record(entry('fact', '部署窗口是周二晚上'))
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_query: '部署窗口' }),
      (card) => verdict({ action: 'answer', project: null, reply: card.recalled[0]?.text ?? '没有' }),
    )
    say('1', '什么时候可以上线')
    await run(leader)
    expect(leader.cards).toHaveLength(2)
    expect(inboxTexts()).toEqual(['部署窗口是周二晚上'])
  })
  it('follows a reference to a Ticket, and the Ticket points on to its messages', async () => {
    setup([ready])
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const ticketId = readTickets(home())[0]?.id
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_refs: [`ticket:${ticketId}`] }),
      () => verdict({ action: 'recall', project: null, recall_refs: ['trigger:cli:1'] }),
      () => verdict({ action: 'answer', project: null, reply: '好' }),
    )
    say('2', '那张单的情况')
    await run(leader)
    const [, second, third] = leader.cards
    expect(second?.recalled[0]).toMatchObject({ ref: `ticket:${ticketId}`, title: 'clamp', outcome: 'completed' })
    expect(JSON.stringify(second?.recalled[0])).toContain('trigger:cli:1')
    expect(third?.recalled[1]).toMatchObject({ ref: 'trigger:cli:1', text: '新建 clamp.js' })
  })
  it('reads a memory by reference, with what it points at and the whole text', async () => {
    setup([ready])
    const long = `开头${'内容'.repeat(400)}`
    memory().record({ ...entry('fact', long), refs: ['trigger:cli:1'] })
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_refs: ['memory:fact'] }),
      () => verdict({ action: 'answer', project: null, reply: '好' }),
    )
    say('1', '查一下')
    await run(leader)
    expect(leader.cards[1]?.recalled[0]).toMatchObject({ ref: 'memory:fact', refs: ['trigger:cli:1'], text: long })
  })
  it('reads a very long record only up to a limit, and says it was cut', async () => {
    setup([ready])
    memory().record(entry('huge', '内容'.repeat(3000)))
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_refs: ['memory:huge'] }),
      () => verdict({ action: 'answer', project: null, reply: '好' }),
    )
    say('1', '查一下')
    await run(leader)
    const recalled = leader.cards[1]?.recalled[0] as { text?: string; truncated?: boolean }
    expect(recalled.truncated).toBe(true)
    expect(recalled.text?.length).toBeLessThan(6000)
  })
  it('reads a thread by reference: its Tickets and its messages', async () => {
    setup([ready])
    say('1', '新建 clamp.js', 'work')
    await run(new CardLeader(route))
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_refs: ['thread:cli:work', 'trigger:cli:1'] }),
      () => verdict({ action: 'answer', project: null, reply: '好' }),
    )
    say('2', '那个话题说了什么')
    await run(leader)
    const [thread, trigger] = leader.cards[1]?.recalled ?? []
    expect(JSON.stringify(thread)).toContain('新建 clamp.js')
    expect(JSON.stringify(thread)).toContain('ticket:')
    expect(JSON.stringify(trigger)).toContain('thread:cli:work')
  })
  it('says a reference leads nowhere, without failing', async () => {
    setup([ready])
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_refs: ['ticket:nope'] }),
      () => verdict({ action: 'answer', project: null, reply: '没有记录' }),
    )
    say('1', '查一下')
    await run(leader)
    expect(leader.cards[1]?.recalled).toEqual([{ ref: 'ticket:nope', missing: true }])
  })
  it('stops offering recalls after two, so one request cannot spend without limit', async () => {
    setup([ready])
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_query: '甲' }),
      () => verdict({ action: 'recall', project: null, recall_query: '乙' }),
      () => verdict({ action: 'answer', project: null, reply: '没有记录' }),
    )
    say('1', '查一下')
    await run(leader)
    expect(leader.cards.map((card) => card.recall_allowed)).toEqual([true, true, false])
  })
  it('refuses a recall once none are left, and one that asks for nothing', () => {
    const context = { projectIds: [], ticketIds: [], memoryIds: [], recallAllowed: false }
    const answer = verdict({ action: 'recall', project: null, recall_query: '甲' })
    expect(() => parseVerdict(answer, context)).toThrow('no recalls left')
    expect(() =>
      parseVerdict(verdict({ action: 'recall', project: null }), { ...context, recallAllowed: true }),
    ).toThrow('recalled nothing')
  })
  it('counts every call of a recall in what the request cost', async () => {
    setup([ready])
    const leader = new CardLeader(
      () => verdict({ action: 'recall', project: null, recall_query: '甲' }),
      () => verdict({ action: 'answer', project: null, reply: '没有' }),
    )
    say('1', '查一下')
    await run(leader)
    expect(readSummary(home()).summary).toMatchObject({ answered: 1 })
    expect(readSummary(home()).summary.costUsd).toBeCloseTo(usage.costUsd * 2)
  })
})

describe('what a manager is given', { timeout: TEST_TIMEOUT_MS }, () => {
  it('rules of its project and everywhere, and never another project', async () => {
    setup([ready])
    addProject(home().projects, { id: 'other', path: projectDir(), brief: 'other' })
    const rule = (id: string, scope: string, body: string) =>
      memory().record({ id, at: new Date().toISOString(), origin: 'human', scope, pinned: true, body })
    rule('mine', 'project:demo', '导出要带 X-MARK-7')
    rule('all', 'global', '提交信息用中文')
    rule('theirs', 'project:other', '别的项目的秘密规则')
    say('1', '新建 clamp.js')
    await run(new CardLeader(route))
    const texts = turns()[0]?.stdin.memories.map((entry) => entry.text)
    expect(texts).toEqual(expect.arrayContaining(['导出要带 X-MARK-7', '提交信息用中文']))
    expect(texts).not.toContain('别的项目的秘密规则')
  })
  it('how many older rules did not fit, so that its report can say so', async () => {
    setup([ready])
    recordRules('project:demo', MANAGER_RULES_SHOWN + 2)
    say('1', '今天如何')
    await run(new CardLeader(route))
    const memories = turns()[0]?.stdin.memories ?? []
    expect(memories.filter((entry) => entry.text)).toHaveLength(MANAGER_RULES_SHOWN)
    expect(memories.at(-1)).toMatchObject({ rules_not_shown: 2 })
  })
  it('not the very request it was just handed, which would only take up a place', async () => {
    setup([ready])
    say('1', '修改 clamp')
    await run(new CardLeader(route))
    expect(turns()[0]?.stdin.memories).toEqual([])
  })
  it('earlier records matching the work, only of its own project', async () => {
    setup([ready])
    addProject(home().projects, { id: 'other', path: projectDir(), brief: 'other' })
    const note = (id: string, scope: string, body: string) =>
      memory().record({ id, at: new Date().toISOString(), origin: 'agent', scope, body })
    note('mine', 'project:demo', 'clamp 之前放在 lib 目录')
    note('theirs', 'project:other', 'clamp 在别的项目里叫 limit')
    say('1', '修改 clamp')
    await run(new CardLeader(route))
    const texts = turns()[0]?.stdin.memories.map((entry) => entry.text)
    expect(texts).toContain('clamp 之前放在 lib 目录')
    expect(texts?.join()).not.toContain('limit')
  })
  it('a new rule on a later turn of the same Ticket', async () => {
    setup([
      { report: { state: 'blocked', summary: '等', question: '继续吗？' } },
      { report: { state: 'ready', summary: '好了' }, takeUp: 'taken_up' },
    ])
    say('1', '新建 clamp.js', 'work')
    await run(new CardLeader(route))
    memory().record({
      id: 'later',
      at: new Date().toISOString(),
      origin: 'human',
      scope: 'global',
      pinned: true,
      body: '新规则',
    })
    say('2', '继续', 'work')
    await run(new CardLeader(route))
    expect(turns()[1]?.stdin.memories.map((entry) => entry.text)).toContain('新规则')
  })
  it('with memory off, nothing', async () => {
    setup([ready])
    memory().record({
      id: 'r',
      at: new Date().toISOString(),
      origin: 'human',
      scope: 'global',
      pinned: true,
      body: '规则',
    })
    say('1', '新建 clamp.js')
    await run(new CardLeader(route), false)
    expect(turns()[0]?.stdin.memories).toEqual([])
  })
})

describe('the command line', () => {
  const capture = () => {
    const lines: string[] = []
    const errors: string[] = []
    return { lines, errors, io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) } }
  }

  it('remembers a rule without a runner, and a later search finds it', async () => {
    const { io, lines } = capture()
    await expect(main(['remember', '提交信息都用', '中文'], io, home())).resolves.toBe(0)
    expect(lines[0]).toMatch(/^remember-/)
    expect(memory().pinned()).toMatchObject([{ body: '提交信息都用 中文', origin: 'human', scope: 'global' }])
  })
  it('scopes a rule to a registered project, and refuses another', async () => {
    addProject(home().projects, { id: 'demo', path: home().home, brief: '' })
    const { io, errors } = capture()
    await main(['remember', '规则', '--project', 'demo'], io, home())
    expect(memory().pinned()[0]?.scope).toBe('project:demo')
    await expect(main(['remember', '规则', '--project', 'ghost'], io, home())).resolves.toBe(1)
    expect(errors[0]).toContain('ghost')
  })
  it('replaces a rule, and refuses to replace one that does not exist', async () => {
    const { io, lines, errors } = capture()
    await main(['remember', '旧规则'], io, home())
    await main(['remember', '新规则', '--supersedes', lines[0] ?? ''], io, home())
    expect(
      memory()
        .pinned()
        .map((rule) => rule.body),
    ).toEqual(['新规则'])
    await expect(main(['remember', '规则', '--supersedes', 'nope'], io, home())).resolves.toBe(1)
    expect(errors[0]).toContain('nope')
  })
  it('lists, searches, shows and forgets', async () => {
    const { io, lines } = capture()
    await main(['remember', '登录要记日志'], io, home())
    const id = lines[0] ?? ''
    await main(['memory', 'list'], io, home())
    expect(lines.at(-1)).toContain('登录要记日志')
    await main(['memory', 'search', '登录', '--json'], io, home())
    expect(JSON.parse(lines.at(-1) ?? '[]')).toMatchObject([{ id }])
    await main(['memory', 'list', '--json'], io, home())
    expect(JSON.parse(lines.at(-1) ?? '[]')).toHaveLength(1)
    await main(['memory', 'show', id], io, home())
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ id, body: '登录要记日志' })
    await main(['memory', 'forget', id, '--reason', '不要了'], io, home())
    await main(['memory', 'search', '登录'], io, home())
    expect(lines.at(-1)).toBe('没有记录')
  })
  it('limits a search to a project and everywhere', async () => {
    addProject(home().projects, { id: 'demo', path: home().home, brief: '' })
    addProject(home().projects, { id: 'other', path: home().home, brief: '' })
    const { io, lines } = capture()
    await main(['remember', '登录甲', '--project', 'demo'], io, home())
    await main(['remember', '登录乙', '--project', 'other'], io, home())
    await main(['memory', 'search', '登录', '--project', 'demo', '--json'], io, home())
    expect(JSON.parse(lines.at(-1) ?? '[]')).toMatchObject([{ body: '登录甲' }])
  })
  it('says what it cannot find, and prints usage for what makes no sense', async () => {
    const { io, errors } = capture()
    await expect(main(['memory', 'show', 'nope'], io, home())).resolves.toBe(1)
    await expect(main(['memory', 'forget', 'nope'], io, home())).resolves.toBe(1)
    expect(errors.slice(0, 2).join()).toContain('nope')
    for (const argv of [['memory'], ['memory', 'search'], ['memory', 'wat', 'x'], ['remember']]) {
      await expect(main(argv, io, home())).resolves.toBe(1)
    }
  })
  it('status still answers', () => {
    expect(readStatus(home(), 0).sent).toBe(0)
  })
})
