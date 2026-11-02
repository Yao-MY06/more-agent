/** A Ticket running through real turn processes, the upstream Engine and the real outbox; only `claude` and `omh` are faked. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import type { ManagerSettings } from '../src/config.ts'
import { appendInbox, readInbox } from '../src/inbox.ts'
import type { Verdict } from '../src/leader/verdict.ts'
import type { Llm, LlmRequest, LlmResult } from '../src/llm/llm.ts'
import { MANAGER_JOB, type ManagerJob } from '../src/manager/executor.ts'
import { addProject } from '../src/projects.ts'
import { readStatus } from '../src/report.ts'
import { Runtime } from '../src/runtime.ts'
import { writeSpool, writeSpoolCommand } from '../src/spool.ts'
import { readTickets, renderTicket } from '../src/tickets-view.ts'
import { usage, useHome, verdict } from './helpers.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const IDLE_LIMIT_MS = 30_000
const TEST_TIMEOUT_MS = 60_000
const POLL_MS = 50

const home = useHome()
const projectDir = () => join(home().home, 'project')
const logFile = () => join(home().home, 'manager.log')
const noticeFile = () => join(projectDir(), 'fake-omh-killed.txt')
const settings = (): ManagerSettings => ({
  model: 'manager-model',
  effort: 'low',
  command: [process.execPath, join(FIXTURES, 'fake-manager.mjs')],
  turnBudgetUsd: 1,
  omh: join(FIXTURES, 'fake-omh.mjs'),
  skill: join(FIXTURES, 'skill.md'),
})

interface Turn {
  turn: number
  args: string[]
  cwd: string
  pid: number
  stdin: {
    note: string
    title?: string
    request?: string[]
    finished?: string[]
    inputs: { kind: string; trigger_id?: string; text?: string }[]
  }
}
const turns = (): Turn[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

/** Routes every request with `verdict`, and words each report as `转述：` plus its question or summary. */
class FakeLeader implements Llm {
  readonly calls: LlmRequest[] = []
  private readonly route: () => Verdict
  constructor(route: () => Verdict = () => verdict({ project: 'demo' })) {
    this.route = route
  }
  async complete(request: LlmRequest): Promise<LlmResult> {
    this.calls.push(request)
    if (request.system.includes('A project manager has reported')) {
      const card = JSON.parse(request.user)
      return { output: { text: `转述：${card.question ?? card.summary}` }, usage }
    }
    return { output: this.route(), usage }
  }
}

function setup(script: unknown[], options: { execute?: boolean; omh?: boolean } = {}): void {
  mkdirSync(projectDir(), { recursive: true })
  if (options.omh !== false) {
    mkdirSync(join(projectDir(), '.omh'), { recursive: true })
    writeFileSync(join(projectDir(), '.omh', 'config.json'), '{}')
  }
  addProject(home().projects, { id: 'demo', path: projectDir(), brief: '', execute: options.execute ?? true })
  const file = join(home().home, 'script.json')
  writeFileSync(file, JSON.stringify(script))
  vi.stubEnv('FAKE_MANAGER_SCRIPT', file)
  vi.stubEnv('FAKE_MANAGER_LOG', logFile())
}

const say = (id: string, text: string, thread = 'work') =>
  writeSpool(home(), { id, source: 'cli', thread, text, at: new Date().toISOString() })

async function open(leader: Llm = new FakeLeader()) {
  return Runtime.open({
    paths: home(),
    llm: leader,
    manager: settings(),
    onLockLost: (error) => {
      throw error
    },
  })
}

async function runToIdle(leader: Llm = new FakeLeader()): Promise<void> {
  const { runtime, release } = await open(leader)
  try {
    await runtime.runUntilIdle(undefined, IDLE_LIMIT_MS)
  } finally {
    await runtime.close()
    await release()
  }
}

async function until(condition: () => boolean, runtime: Runtime): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > IDLE_LIMIT_MS) throw new Error('The condition did not come true')
    runtime.tick()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

const inboxTexts = () => readInbox(home()).entries.map((entry) => entry.text)
const argAfter = (turn: Turn | undefined, flag: string) => turn?.args[turn.args.indexOf(flag) + 1]

beforeEach(() => {
  vi.stubEnv('FAKE_MANAGER_LOG', logFile())
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a Ticket of a project with execution on', { timeout: TEST_TIMEOUT_MS }, () => {
  it('when the manager finishes, the person hears the acknowledgement and the Leader-worded result', async () => {
    setup([{ report: { state: 'ready', summary: '加好了，在分支 omh/T1' } }])
    say('1', '加一个函数')
    await runToIdle()
    expect(inboxTexts()).toEqual(['On it.', '转述：加好了，在分支 omh/T1'])
    expect(readTickets(home())).toMatchObject([{ project: 'demo', outcome: 'completed', turns: 1, costUsd: 0.1 }])
  })

  it('runs in the project directory with the request, its own session, and no way to run commands', async () => {
    setup([{ report: { state: 'ready', summary: 'done' } }])
    say('1', '加一个函数')
    await runToIdle()
    const [turn] = turns()
    expect(turn?.cwd.toLowerCase()).toBe(projectDir().toLowerCase())
    expect(turn?.stdin.request).toEqual(['加一个函数'])
    expect(argAfter(turn, '--session-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(argAfter(turn, '--tools')).not.toContain('Bash')
    expect(argAfter(turn, '--allowedTools')).not.toContain('Bash')
    expect(argAfter(turn, '--allowedTools')).not.toContain('omh_wait')
    expect(argAfter(turn, '--allowedTools')).toContain('Edit(_tickets/**)')
    expect(argAfter(turn, '--permission-mode')).toBe('dontAsk')
    expect(argAfter(turn, '--model')).toBe('manager-model')
    expect(argAfter(turn, '--max-budget-usd')).toBe('1')
    const prompt = readFileSync(argAfter(turn, '--append-system-prompt-file') ?? '', 'utf8')
    expect(prompt).toContain('SKILL-BODY-MARKER')
    expect(prompt).not.toContain('不适用的部分')
  })

  it('when the manager asks a question, the person is asked, and their answer resumes the same session', async () => {
    setup([
      { report: { state: 'blocked', summary: '两种做法都行', question: '用 A 还是 B？' } },
      { report: { state: 'ready', summary: '用 A 做完了' }, takeUp: 'taken_up' },
    ])
    say('1', '做这个')
    await runToIdle()
    expect(inboxTexts()).toContain('转述：用 A 还是 B？')
    expect(readTickets(home())).toMatchObject([{ stage: 'person', question: '用 A 还是 B？' }])
    say('2', '用 A')
    await runToIdle()
    const [first, second] = turns()
    expect(argAfter(second, '--resume')).toBe(argAfter(first, '--session-id'))
    expect(second?.stdin.inputs).toMatchObject([{ kind: 'message', text: '用 A' }])
    expect(inboxTexts()).toEqual(['On it.', '转述：用 A 还是 B？', '回应：用 A', '转述：用 A 做完了'])
    expect(readTickets(home())).toMatchObject([{ outcome: 'completed' }])
  })

  it('when a message arrives during a turn, that turn cannot finish the Ticket and the next turn gets it', async () => {
    setup([
      { report: { state: 'ready', summary: '第一轮完成' }, delayMs: 1500 },
      { report: { state: 'ready', summary: '第二轮也完成' }, takeUp: 'taken_up' },
    ])
    say('1', '做这个')
    const { runtime, release } = await open()
    await until(() => turns().length === 1, runtime)
    say('2', '顺便改个名')
    await until(() => !runtime.busy(), runtime)
    await runtime.close()
    await release()
    expect(turns()).toHaveLength(2)
    expect(turns()[1]?.stdin.inputs).toMatchObject([{ kind: 'message', text: '顺便改个名' }])
    expect(inboxTexts()).not.toContain('转述：第一轮完成')
    expect(inboxTexts()).toContain('转述：第二轮也完成')
  })

  it('when the manager waits for workers, nothing runs until they end, then it is woken with their names', async () => {
    setup([
      { report: { state: 'waiting', summary: '派了 T1', wait_for: ['T1'] } },
      { report: { state: 'ready', summary: 'T1 验收通过' } },
    ])
    writeFileSync(join(projectDir(), 'fake-omh-running.json'), '["T1"]')
    say('1', '做这个')
    const leader = new FakeLeader()
    const { runtime, release } = await open(leader)
    await until(() => turns().length === 1 && readTickets(home())[0]?.stage === 'idle', runtime)
    const callsWhileWaiting = leader.calls.length
    await new Promise((resolve) => setTimeout(resolve, 1500))
    runtime.tick()
    expect(turns()).toHaveLength(1)
    expect(leader.calls).toHaveLength(callsWhileWaiting)
    writeFileSync(join(projectDir(), 'fake-omh-running.json'), '[]')
    await until(() => !runtime.busy(), runtime)
    await runtime.close()
    await release()
    expect(turns()[1]?.stdin.finished).toEqual(['T1'])
    expect(inboxTexts()).toContain('转述：T1 验收通过')
  })

  it('when a person writes while the manager waits for workers, it is woken right away', async () => {
    setup([
      { report: { state: 'waiting', summary: '派了 T1', wait_for: ['T1'] } },
      { report: { state: 'ready', summary: '好了' }, takeUp: 'taken_up' },
    ])
    writeFileSync(join(projectDir(), 'fake-omh-running.json'), '["T1"]')
    say('1', '做这个')
    const { runtime, release } = await open()
    await until(() => readTickets(home())[0]?.stage === 'idle', runtime)
    say('2', '进度如何？')
    await until(() => !runtime.busy(), runtime)
    await runtime.close()
    await release()
    expect(turns()[1]?.stdin.inputs).toMatchObject([{ text: '进度如何？' }])
    expect(inboxTexts()).toContain('回应：进度如何？')
  })

  it('when the manager hands a message back, the Leader decides it as new work', async () => {
    setup([
      { report: { state: 'blocked', summary: '等回答', question: '继续吗？' } },
      { report: { state: 'ready', summary: '完成' }, takeUp: 'hand_back' },
      { report: { state: 'ready', summary: '新工作完成' } },
    ])
    say('1', '做这个')
    const leader = new FakeLeader()
    await runToIdle(leader)
    const before = leader.calls.filter((call) => !call.system.includes('A project manager')).length
    say('2', '另外帮我做件别的事')
    await runToIdle(leader)
    expect(leader.calls.filter((call) => !call.system.includes('A project manager')).length).toBe(before + 1)
    expect(readTickets(home())).toHaveLength(2)
  })

  it('when two requests go to one project, the second waits for the first', async () => {
    setup([
      { report: { state: 'ready', summary: '第一张' }, delayMs: 800 },
      { report: { state: 'ready', summary: '第二张' } },
    ])
    say('1', '第一件事', 'a')
    say('2', '第二件事', 'b')
    const { runtime, release } = await open()
    await until(() => turns().length >= 1, runtime)
    expect(turns()).toHaveLength(1)
    await until(() => !runtime.busy(), runtime)
    await runtime.close()
    await release()
    expect(turns()).toHaveLength(2)
    expect(turns()[1]?.stdin.request).toEqual(turns()[1]?.stdin.request)
    expect(readTickets(home()).every((row) => row.outcome === 'completed')).toBe(true)
  })
})

describe('when a turn goes wrong', { timeout: TEST_TIMEOUT_MS }, () => {
  it('and the process fails, the person is told why and can get it going again by replying', async () => {
    setup([{ exit: 3, stderr: 'quota exhausted' }, { report: { state: 'ready', summary: '好了' } }])
    say('1', '做这个')
    await runToIdle()
    expect(inboxTexts().join()).toContain('quota exhausted')
    expect(readTickets(home())).toMatchObject([{ stage: 'person' }])
    say('2', '再试试')
    await runToIdle()
    expect(inboxTexts()).toContain('转述：好了')
  })

  it('and the report breaks the rules, it counts as a failure and nothing of it is applied', async () => {
    setup([{ report: { state: 'blocked', summary: '没写问题' } }])
    say('1', '做这个')
    await runToIdle()
    expect(inboxTexts().join()).toContain('汇报不合规')
    expect(readTickets(home())).toMatchObject([{ stage: 'person' }])
  })

  it('and the output is not JSON, it counts as a failure', async () => {
    setup([{ raw: 'not json' }])
    say('1', '做这个')
    await runToIdle()
    expect(inboxTexts().join()).toContain('这一轮出错了')
  })

  it('and the session was lost, the next turn starts it afresh instead of failing forever', async () => {
    setup([
      { report: { state: 'blocked', summary: '问', question: '继续？' } },
      { exit: 1, stderr: 'No conversation found with session ID' },
      { report: { state: 'ready', summary: '重新开始后完成' } },
    ])
    say('1', '做这个')
    await runToIdle()
    say('2', '继续')
    await runToIdle()
    expect(turns()).toHaveLength(3)
    expect(argAfter(turns()[1], '--resume')).toBeTruthy()
    expect(argAfter(turns()[2], '--session-id')).toBeTruthy()
    expect(inboxTexts()).toContain('转述：重新开始后完成')
  })

  it('and it cost past the Ticket budget, no further turn starts and the person is asked', async () => {
    setup([{ report: { state: 'waiting', summary: '贵', wait_for: ['T1'] }, costUsd: 100 }])
    say('1', '做这个')
    await runToIdle()
    expect(turns()).toHaveLength(1)
    expect(inboxTexts().join()).toContain('超过上限')
  })
})

describe('before a turn starts', { timeout: TEST_TIMEOUT_MS }, () => {
  it('when the switch is off, no process starts and nothing touches the project', async () => {
    setup([{ report: { state: 'ready', summary: 'x' } }], { execute: false })
    say('1', '做这个')
    await runToIdle()
    expect(turns()).toEqual([])
    expect(existsSync(home().jobs)).toBe(false)
    expect(readTickets(home())).toMatchObject([{ outcome: 'completed', turns: 0 }])
    expect(readStatus(home(), 0)).toMatchObject({ sent: 0 })
  })

  it('when the project has no omh setup, the person is told and no process starts', async () => {
    setup([{ report: { state: 'ready', summary: 'x' } }], { omh: false })
    say('1', '做这个')
    await runToIdle()
    expect(turns()).toEqual([])
    expect(inboxTexts().join()).toContain('还没有配置 omh')
  })

  it('when the skill file is missing, the person is told rather than the manager running without its workflow', async () => {
    setup([{ report: { state: 'ready', summary: 'x' } }])
    say('1', '做这个')
    const leader = new FakeLeader()
    const { runtime, release } = await Runtime.open({
      paths: home(),
      llm: leader,
      manager: { ...settings(), skill: join(home().home, 'missing.md') },
      onLockLost: (error) => {
        throw error
      },
    })
    await runtime.runUntilIdle(undefined, IDLE_LIMIT_MS)
    await runtime.close()
    await release()
    expect(turns()).toEqual([])
    expect(inboxTexts().join()).toContain('技能文件')
  })
})

describe('when the runner goes away', { timeout: TEST_TIMEOUT_MS }, () => {
  it('a running turn carries on, and the next runner collects it once without starting another', async () => {
    setup([{ report: { state: 'ready', summary: '跑完了' }, delayMs: 1500 }])
    say('1', '做这个')
    const first = await open()
    await until(() => turns().length === 1, first.runtime)
    await first.runtime.close()
    await first.release()
    await runToIdle()
    expect(turns()).toHaveLength(1)
    expect(inboxTexts().filter((text) => text === '转述：跑完了')).toHaveLength(1)
  })

  it('a turn that died is started again in the same session, told to look before acting', async () => {
    setup([
      { report: { state: 'waiting', summary: '派了', wait_for: ['T1'] } },
      { report: { state: 'ready', summary: '恢复后完成' } },
    ])
    writeFileSync(join(projectDir(), 'fake-omh-running.json'), '["T1"]')
    say('1', '做这个')
    const first = await open()
    await until(() => readTickets(home())[0]?.stage === 'idle', first.runtime)
    const { store } = first.runtime
    const [name] = store.keys(MANAGER_JOB)
    const job = store.get(name as never) as unknown as ManagerJob
    // As if the supervisor vanished mid-turn: a turn on record whose directory holds nothing.
    store.set(name as never, { ...job, phase: 'turn', directory: join(home().home, 'gone') } as never)
    await first.runtime.close()
    await first.release()
    await runToIdle()
    const last = turns().at(-1)
    expect(argAfter(last, '--resume')).toBeTruthy()
    expect(last?.stdin.note).toContain('上一轮被中断了')
    expect(inboxTexts()).toContain('转述：恢复后完成')
  })
})

describe('stopping a Ticket', { timeout: TEST_TIMEOUT_MS }, () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('ends its manager and its workers, and the person gets no result afterwards', async () => {
    setup([{ report: { state: 'ready', summary: '不该出现' }, delayMs: 60_000 }])
    writeFileSync(join(projectDir(), 'fake-omh-running.json'), '["T7"]')
    say('1', '做这个')
    const { runtime, release } = await open()
    await until(() => turns().length === 1, runtime)
    const [row] = readTickets(home())
    const lines: string[] = []
    await main(
      ['stop', row?.id.slice(0, 8) ?? '', '--reason', '不要了'],
      { out: (line) => lines.push(line), err: () => {} },
      home(),
    )
    expect(lines[0]).toContain('已提交停止')
    await until(() => readTickets(home())[0]?.outcome === 'stopped' && existsSync(noticeFile()), runtime)
    const pid = turns()[0]?.pid ?? 0
    await until(() => !alive(pid), runtime)
    await runtime.close()
    await release()
    expect(readFileSync(noticeFile(), 'utf8')).toContain('T7')
    expect(inboxTexts().join()).not.toContain('不该出现')
  })

  it('catches a worker the manager dispatches while the stop is on its way', async () => {
    setup([{ report: { state: 'ready', summary: '不该出现' }, delayMs: 60_000, lateWorkerMs: 1500 }])
    say('1', '做这个')
    const { runtime, release } = await open()
    await until(() => turns().length === 1, runtime)
    const [row] = readTickets(home())
    await main(['stop', row?.id.slice(0, 8) ?? ''], { out: () => {}, err: () => {} }, home())
    await until(() => readTickets(home())[0]?.outcome === 'stopped', runtime)
    await until(() => !runtime.busy(), runtime)
    await runtime.close()
    await release()
    expect(readFileSync(noticeFile(), 'utf8')).toContain('T9')
  })

  it('refuses a prefix that matches nothing', async () => {
    const errors: string[] = []
    await expect(main(['stop', 'nope'], { out: () => {}, err: (line) => errors.push(line) }, home())).resolves.toBe(1)
    expect(errors[0]).toContain('nope')
  })

  it('with no prefix prints usage', async () => {
    await expect(main(['stop'], { out: () => {}, err: () => {} }, home())).resolves.toBe(1)
  })
})

describe('the tickets command', { timeout: TEST_TIMEOUT_MS }, () => {
  it('shows stage, project, question and cost', async () => {
    setup([{ report: { state: 'blocked', summary: '问', question: '用哪个？' } }])
    say('1', '做这个')
    await runToIdle()
    const lines: string[] = []
    const io = { out: (line: string) => lines.push(line), err: () => {} }
    await main(['tickets'], io, home())
    expect(lines[0]).toContain('等你')
    expect(lines[0]).toContain('demo')
    expect(lines[0]).toContain('用哪个？')
    expect(lines[0]).toContain('$0.10')
    await main(['tickets', '--json'], io, home())
    expect(JSON.parse(lines[1] ?? '[]')).toMatchObject([{ project: 'demo', turns: 1 }])
  })
  it('with no database says there are none', async () => {
    const lines: string[] = []
    await main(['tickets'], { out: (line) => lines.push(line), err: () => {} }, home())
    expect(lines).toEqual(['还没有工单'])
    expect(
      renderTicket({ id: 'abc', title: 't', stage: 'ended', outcome: 'completed', turns: 0, costUsd: 0 }),
    ).toContain('已结束')
    appendInbox(home(), { id: 'x', at: 'now', thread: 'cli:t', kind: 'notice', text: 't' })
  })
})

describe('background trouble', { timeout: TEST_TIMEOUT_MS }, () => {
  it('when asked to stop a Ticket that does not exist, the person is told and the spool moves on', async () => {
    writeSpoolCommand(home(), { command: 'stop', ticketId: 'no-such-ticket' })
    say('1', '之后的请求', 'later')
    setup([{ report: { state: 'ready', summary: '好了' } }])
    await runToIdle()
    expect(inboxTexts().join()).toContain('没能停止工单 no-such-ticket')
    expect(inboxTexts()).toContain('转述：好了')
  })

  it('when the manager setup breaks mid-way, the runner reports it once instead of crashing or repeating', async () => {
    setup([{ report: { state: 'waiting', summary: '派了', wait_for: ['T1'] } }])
    writeFileSync(join(projectDir(), 'fake-omh-running.json'), '[]')
    say('1', '做这个')
    const skill = join(home().home, 'skill-copy.md')
    writeFileSync(skill, readFileSync(settings().skill))
    const errors: unknown[] = []
    const { runtime, release } = await Runtime.open({
      paths: home(),
      llm: new FakeLeader(),
      manager: { ...settings(), skill },
      onLockLost: (error) => {
        throw error
      },
      onError: (error) => errors.push(error),
    })
    await until(() => readTickets(home())[0]?.stage === 'idle', runtime)
    rmSync(skill)
    const started = Date.now()
    while (!errors.length && Date.now() - started < IDLE_LIMIT_MS) {
      runtime.tick()
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    for (let tick = 0; tick < 5; tick++) {
      runtime.tick()
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    await runtime.close()
    await release()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('skill-copy.md')
  })
})

describe('what a Ticket has cost', { timeout: TEST_TIMEOUT_MS }, () => {
  const reply = (id: string, text: string) => say(id, text)

  it('counts each turn once, since the CLI reports the running total of a resumed session', async () => {
    setup([
      { report: { state: 'blocked', summary: '问', question: '一？' }, costUsd: 0.1 },
      { report: { state: 'blocked', summary: '问', question: '二？' }, costUsd: 0.3 },
      { report: { state: 'ready', summary: '好了' }, costUsd: 0.6 },
    ])
    reply('1', '做这个')
    await runToIdle()
    reply('2', '答一')
    await runToIdle()
    reply('3', '答二')
    await runToIdle()
    expect(readTickets(home())[0]?.costUsd).toBeCloseTo(0.6)
  })

  it('starts counting again when a lost session is replaced by a new one', async () => {
    setup([
      { report: { state: 'blocked', summary: '问', question: '一？' }, costUsd: 0.2 },
      { exit: 1, stderr: 'No conversation found with session ID' },
      { report: { state: 'ready', summary: '好了' }, costUsd: 0.05 },
    ])
    reply('1', '做这个')
    await runToIdle()
    reply('2', '继续')
    await runToIdle()
    expect(readTickets(home())[0]?.costUsd).toBeCloseTo(0.25)
  })

  it('does not stop a Ticket early by adding running totals together', async () => {
    setup([
      { report: { state: 'blocked', summary: '问', question: '一？' }, costUsd: 9 },
      { report: { state: 'ready', summary: '没超预算' }, costUsd: 10 },
    ])
    reply('1', '做这个')
    await runToIdle()
    reply('2', '答')
    await runToIdle()
    expect(inboxTexts()).toContain('转述：没超预算')
    expect(readTickets(home())[0]?.costUsd).toBeCloseTo(10)
  })

  it('counts a turn the CLI stopped for its budget, and says so in plain words', async () => {
    const budgetStop = JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 3.2 })
    setup([{ raw: budgetStop, exit: 1 }])
    reply('1', '做这个')
    await runToIdle()
    expect(readTickets(home())[0]?.costUsd).toBeCloseTo(3.2)
    const said = inboxTexts().join()
    expect(said).toContain('预算')
    expect(said).not.toContain('{')
  })
})
