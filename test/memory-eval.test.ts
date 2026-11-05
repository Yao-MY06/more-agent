/** The evaluation harness itself: if it could not tell a right answer from a wrong one, its numbers would mean nothing. */
import { describe, expect, it } from 'vitest'
import { CASES, type MemoryCase, noiseMemories, PROJECTS } from '../eval/memory-cases.ts'
import { judge, renderResults, runCase, seedMemories } from '../eval/memory-eval.ts'
import { pathsFor } from '../src/config.ts'
import { buildContext, type ContextHost } from '../src/leader/context.ts'
import type { Verdict } from '../src/leader/verdict.ts'
import type { Llm, LlmRequest, LlmResult } from '../src/llm/llm.ts'
import { MemoryStore } from '../src/memory/store.ts'
import type { Candidate } from '../vendor/dsh-superagent/src/core/index.ts'
import { usage, useHome, verdict } from './helpers.ts'

const TEST_TIMEOUT_MS = 30_000
const home = useHome()

interface Card {
  rules: { id: string; text: string }[]
  memory: { id: string; text: string }[]
  work: { id: string; title: string }[]
}

class ScriptedLeader implements Llm {
  readonly cards: Card[] = []
  private readonly reply: (card: Card) => Verdict
  constructor(reply: (card: Card) => Verdict) {
    this.reply = reply
  }
  async complete(request: LlmRequest): Promise<LlmResult> {
    const card = JSON.parse(request.user) as Card
    this.cards.push(card)
    return { output: this.reply(card), usage }
  }
}

const observed = (overrides = {}) => ({ outcome: 'answer', said: '', scope: '', replaced: () => false, ...overrides })

describe('judging an answer', () => {
  it('passes what meets every expectation', () => {
    expect(judge({ outcomes: ['answer'], says: ['ZX-4471-Q'] }, observed({ said: '标记是 ZX-4471-Q' }))).toEqual([])
  })
  it('fails the wrong outcome, a missing fact, a forbidden claim, an old fact left standing and a leak', () => {
    expect(judge({ outcomes: ['attach'] }, observed())).toHaveLength(1)
    expect(judge({ outcomes: ['answer'], says: ['甲', '乙'] }, observed({ said: '甲' }))).toEqual(['没有说到：乙'])
    expect(judge({ outcomes: ['answer'], neverSays: ['周二'] }, observed({ said: '周二' }))).toEqual(['不该说：周二'])
    expect(judge({ outcomes: ['answer'], replaces: 'old' }, observed())).toEqual(['没有取代记录：old'])
    expect(judge({ outcomes: ['answer'], scopeNeverSays: '秘密' }, observed({ scope: '秘密' }))).toHaveLength(1)
  })
})

describe('judging a refusal', () => {
  const refuses = { outcomes: ['answer'], saysAnyOf: ['没有', '查不到'] }
  it('accepts any of the ways to say it does not know', () => {
    expect(judge(refuses, observed({ said: '这里查不到' }))).toEqual([])
  })
  it('fails an answer that claims to know', () => {
    expect(judge(refuses, observed({ said: '商户号是 123' }))).toEqual(['没有说到任何一个：没有、查不到'])
  })
})

describe('the question set', () => {
  it('has unique ids and covers every category it claims', () => {
    expect(new Set(CASES.map((item) => item.id)).size).toBe(CASES.length)
    expect(new Set(CASES.map((item) => item.category)).size).toBe(7)
  })
  it('only ever seeds work for registered projects', () => {
    const projects = PROJECTS.map((project) => project.id)
    for (const ticket of CASES.flatMap((item) => item.tickets ?? [])) expect(projects).toContain(ticket.project)
  })
  it('never gives the answer away in the question', () => {
    for (const item of CASES) {
      for (const text of item.expect.says ?? []) {
        if (item.category === 'C1 逐字保留') expect(item.ask).not.toContain(text)
      }
    }
  })
})

describe('unrelated records', () => {
  const ANSWERS = [
    'ZX-',
    'omh/',
    '2222',
    'vitest',
    'jest',
    '周四',
    '周二',
    'snake_case',
    'Redis',
    '支付宝',
    '商户',
    '迁移',
    '命名',
    '蓝绿',
    'flaky',
  ]
  it('are the same on every run, so that two runs compare', () => {
    expect(noiseMemories(50)).toEqual(noiseMemories(50))
    expect(new Set(noiseMemories(50).map((entry) => entry.id)).size).toBe(50)
  })
  it('never hold an answer, nor a digit an answer could be read off', () => {
    const text = noiseMemories(300)
      .map((entry) => entry.body)
      .join('\n')
    for (const answer of ANSWERS) expect(text).not.toContain(answer)
    expect(text).not.toMatch(/\d/)
  })
  it('include some rules, so that rules must compete for the card too', () => {
    expect(noiseMemories(300).filter((entry) => entry.pinned).length).toBeGreaterThan(10)
  })
  it('stay older than a question about what is recent', () => {
    expect(Math.min(...noiseMemories(300, 4).map((entry) => entry.daysAgo))).toBeGreaterThan(4)
  })
})

describe('among unrelated records, without a model', { timeout: TEST_TIMEOUT_MS }, () => {
  const NOISE = 300
  const noWork = { tickets: { open: () => [], list: () => [] }, decisions: { get: () => undefined } }
  for (const item of CASES.filter((candidate) => candidate.needs)) {
    it(`${item.id}: the records its answer needs reach the card`, () => {
      const memory = new MemoryStore(pathsFor(home().home).memory)
      seedMemories(memory, item, Date.now(), NOISE)
      const host = { store: noWork, memory, enabled: true } as unknown as ContextHost
      const candidate = { triggers: [{ text: item.ask }] } as unknown as Candidate
      const context = buildContext(host, candidate, [], true)
      const shown = [...context.rules, ...context.memory].map((entry) => (entry as { id: string }).id)
      memory.close()
      expect(shown).toEqual(expect.arrayContaining([...(item.needs ?? [])]))
    })
  }
})

describe('running a question', { timeout: TEST_TIMEOUT_MS }, () => {
  const fact: MemoryCase = {
    id: 'fact',
    category: 'C1 逐字保留',
    memories: [{ id: 'm', daysAgo: 3, origin: 'human', scope: 'global', body: '标记是 ZX-1' }],
    ask: '标记是什么？',
    expect: { outcomes: ['answer'], says: ['ZX-1'] },
  }
  const answerFromMemory = (card: Card) =>
    verdict({ action: 'answer', project: null, reply: card.memory[0]?.text ?? '没有记录' })

  it('with memory on, the card holds what was seeded, and the right answer passes', async () => {
    const leader = new ScriptedLeader(answerFromMemory)
    const result = await runCase(fact, leader, true, home().home)
    expect(leader.cards[0]?.memory[0]?.text).toBe('标记是 ZX-1')
    expect(result).toMatchObject({ pass: true, outcome: 'answer', memory: true })
    expect(result.costUsd).toBe(usage.costUsd)
  })
  it('with memory off, the card holds nothing, and the same leader fails', async () => {
    const leader = new ScriptedLeader(answerFromMemory)
    const result = await runCase(fact, leader, false, home().home)
    expect(leader.cards[0]?.memory).toEqual([])
    expect(result).toMatchObject({ pass: false, failures: ['没有说到：ZX-1'] })
  })
  it('seeds earlier work as real Tickets without a model, so an attach can point at one', async () => {
    const work: MemoryCase = {
      id: 'work',
      category: 'C2 检索精度',
      tickets: [{ daysAgo: 3, project: 'ops-tools', title: '备份脚本', request: '写备份脚本' }],
      ask: '接着上次的备份脚本做',
      expect: { outcomes: ['attach', 'ops-tools'] },
    }
    const leader = new ScriptedLeader((card) =>
      verdict({ action: 'attach', project: null, ticket: card.work[0]?.id ?? null, acknowledgement: '好' }),
    )
    const result = await runCase(work, leader, true, home().home)
    expect(leader.cards).toHaveLength(1)
    expect(leader.cards[0]?.work).toMatchObject([{ title: '备份脚本' }])
    expect(result).toMatchObject({ pass: true, outcome: 'attach' })
  })
  it('notices a replacement of a seeded rule', async () => {
    const replace: MemoryCase = {
      id: 'replace',
      category: 'C3 过期事实',
      memories: [{ id: 'rule', daysAgo: 3, origin: 'human', scope: 'global', pinned: true, body: '部署走蓝绿' }],
      ask: '记住：改成滚动发布',
      expect: { outcomes: ['remember'], replaces: 'rule' },
    }
    const leader = new ScriptedLeader((card) =>
      verdict({ action: 'remember', project: null, reply: '好', supersedes: card.rules[0]?.id ?? null }),
    )
    const result = await runCase(replace, leader, true, home().home)
    expect(result.pass).toBe(true)
    expect(new MemoryStore(pathsFor(home().home).memory).pinned().map((rule) => rule.body)).toEqual([
      '记住：改成滚动发布',
    ])
  })
  it('puts unrelated records into the store when asked, and the right record still reaches the card', async () => {
    const leader = new ScriptedLeader(answerFromMemory)
    const result = await runCase(fact, leader, true, home().home, 100)
    expect(result.pass).toBe(true)
    expect(new MemoryStore(pathsFor(home().home).memory).list(200).length).toBeGreaterThan(100)
  })
  it('catches a rule leaking into what a manager would be told, even under a clean title', async () => {
    const leak: MemoryCase = {
      id: 'leak',
      category: 'C5 作用范围',
      ask: '给 ops-tools 写脚本',
      expect: { outcomes: ['ops-tools'], scopeNeverSays: '秘密' },
    }
    const leader = new ScriptedLeader(() =>
      verdict({ project: 'ops-tools', title: '写脚本', scope: '写脚本，按秘密规则' }),
    )
    const result = await runCase(leak, leader, true, home().home)
    expect(result.failures).toEqual(['工单范围里混进了：秘密'])
  })
  it('never starts a manager, whatever the leader answers', async () => {
    const route: MemoryCase = {
      id: 'route',
      category: '对照',
      ask: '给 ops-tools 写脚本',
      expect: { outcomes: ['ops-tools'] },
    }
    const result = await runCase(route, new ScriptedLeader(() => verdict({ project: 'ops-tools' })), true, home().home)
    expect(result.pass).toBe(true)
    const { existsSync } = await import('node:fs')
    expect(existsSync(pathsFor(home().home).jobs)).toBe(false)
  })
})

describe('the summary', () => {
  it('shows each category with and without memory, and what failed', () => {
    const row = { id: 'x', category: 'C3 过期事实' as const, outcome: 'answer', said: '周二', costUsd: 0.5, seconds: 1 }
    const text = renderResults([
      { ...row, memory: false, pass: false, failures: ['没有说到：周四'] },
      { ...row, memory: true, pass: true, failures: [] },
    ])
    expect(text).toContain('| C3 过期事实 | 0/1（0%） | 1/1（100%） |')
    expect(text).toContain('**x**（无记忆）：没有说到：周四')
    expect(text).toContain('$1.000')
  })
  it('shows a dash for a group that did not run', () => {
    const row = { id: 'x', category: 'C3 过期事实' as const, outcome: 'answer', said: '', costUsd: 0, seconds: 1 }
    expect(renderResults([{ ...row, memory: true, pass: true, failures: [] }])).toContain(
      '| C3 过期事实 | - | 1/1（100%） |',
    )
  })
})
