/**
 * Measures what memory is worth: every question runs twice through the real Runtime, with memory off and on, and a program
 * judges each answer. Earlier work is seeded without any model call. Only the final question reaches the model under test.
 *
 *   node lib/eval/memory-eval.js <output directory> [--only id] [--concurrency n] [--noise n]
 *
 * With --noise, n unrelated records join every question's store, and only the group with memory runs: without memory the card is
 * empty either way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { leaderSettings, type Paths, pathsFor } from '../src/config.ts'
import { readInbox } from '../src/inbox.ts'
import type { Verdict } from '../src/leader/verdict.ts'
import { ClaudeCli } from '../src/llm/claude-cli.ts'
import type { Llm, LlmRequest, LlmResult } from '../src/llm/llm.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { addProject } from '../src/projects.ts'
import { decisionRows } from '../src/report.ts'
import { Runtime } from '../src/runtime.ts'
import { writeSpool } from '../src/spool.ts'
import { CASES, type Category, type Expectation, type MemoryCase, noiseMemories, PROJECTS } from './memory-cases.ts'

const DAY_MS = 24 * 60 * 60_000
const IDLE_LIMIT_MS = 5 * 60_000
const DEFAULT_CONCURRENCY = 3
const ANSWER_THREAD = 'eval-final'
const PERCENT = 100

const NO_USAGE = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 }

/** Routes seed requests by the marker the seed put on them, without calling a model. */
class SeedLeader implements Llm {
  async complete(request: LlmRequest): Promise<LlmResult> {
    const [message] = (JSON.parse(request.user) as { request: { text: string }[] }).request
    const [, project, title] = message?.text.match(/^\[seed:([^:]+):([^\]]+)\]/) ?? []
    const output: Verdict = {
      action: 'route',
      project: project ?? null,
      ticket: null,
      title: title ?? 'seed',
      scope: message?.text ?? '',
      reason: 'seed',
      acknowledgement: null,
      question: null,
      reply: null,
      supersedes: null,
      recall_query: null,
      recall_refs: [],
      confidence: 1,
    }
    return { output, usage: NO_USAGE }
  }
}

async function runToIdle(paths: Paths, llm: Llm, memoryEnabled: boolean): Promise<void> {
  const { runtime, release } = await Runtime.open({
    paths,
    llm,
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

/** Oldest first, the order they would have been written in. */
export function seedMemories(memory: MemoryStore, testCase: MemoryCase, now: number, noise: number): void {
  const memories = testCase.memories ?? []
  const newerThan = testCase.recencyMatters ? Math.max(...memories.map((entry) => entry.daysAgo)) : 0
  const ordered = [...memories, ...noiseMemories(noise, newerThan)].sort((a, b) => b.daysAgo - a.daysAgo)
  for (const { daysAgo, ...entry } of ordered) {
    memory.record({ ...entry, at: new Date(now - daysAgo * DAY_MS).toISOString() })
  }
}

async function seed(paths: Paths, testCase: MemoryCase, now: number, noise: number): Promise<void> {
  // Every project stays in shadow: an evaluation of the Leader must never start a manager.
  for (const project of PROJECTS) addProject(paths.projects, { id: project.id, path: paths.home, brief: project.brief })
  const memory = new MemoryStore(paths.memory)
  seedMemories(memory, testCase, now, noise)
  memory.close()
  if (!testCase.tickets?.length) return
  testCase.tickets.forEach((ticket, index) => {
    writeSpool(paths, {
      id: `seed-${index}`,
      source: 'cli',
      thread: `seed-${index}`,
      text: `[seed:${ticket.project}:${ticket.title}] ${ticket.request}`,
      at: new Date(now - ticket.daysAgo * DAY_MS).toISOString(),
    })
  })
  await runToIdle(paths, new SeedLeader(), true)
}

export interface CaseResult {
  id: string
  category: Category
  memory: boolean
  pass: boolean
  failures: string[]
  outcome: string
  said: string
  costUsd: number
  seconds: number
}

/** A program's judgement of one answer, so nobody, including the author, gets to mark it generously. */
export function judge(
  expectation: Expectation,
  observed: { outcome: string; said: string; scope: string; replaced: (id: string) => boolean },
): string[] {
  const failures: string[] = []
  const { outcomes, says = [], saysAnyOf, neverSays = [], replaces, scopeNeverSays } = expectation
  if (!outcomes.includes(observed.outcome)) failures.push(`结果是 ${observed.outcome}，应为 ${outcomes.join(' 或 ')}`)
  for (const text of says) if (!observed.said.includes(text)) failures.push(`没有说到：${text}`)
  if (saysAnyOf && !saysAnyOf.some((text) => observed.said.includes(text))) {
    failures.push(`没有说到任何一个：${saysAnyOf.join('、')}`)
  }
  for (const text of neverSays) if (observed.said.includes(text)) failures.push(`不该说：${text}`)
  if (replaces && !observed.replaced(replaces)) failures.push(`没有取代记录：${replaces}`)
  if (scopeNeverSays && observed.scope.includes(scopeNeverSays)) failures.push(`工单范围里混进了：${scopeNeverSays}`)
  return failures
}

export async function runCase(
  testCase: MemoryCase,
  llm: Llm,
  memoryEnabled: boolean,
  home: string,
  noise = 0,
): Promise<CaseResult> {
  const paths = pathsFor(home)
  const now = Date.now()
  await seed(paths, testCase, now, noise)
  const seeded = decisionRows(paths).length
  writeSpool(paths, {
    id: 'final',
    source: 'cli',
    thread: ANSWER_THREAD,
    text: testCase.ask,
    at: new Date(now).toISOString(),
  })
  const started = Date.now()
  await runToIdle(paths, llm, memoryEnabled)
  const row = decisionRows(paths)
    .slice(seeded)
    .find((item) => item.triggerId === 'cli:final')
  const said = readInbox(paths)
    .entries.map((entry) => entry.text)
    .join('\n')
  const memory = new MemoryStore(paths.memory)
  const outcome = row?.outcome ?? 'no decision'
  const failures = judge(testCase.expect, {
    outcome,
    said,
    scope: row?.scope ?? '',
    replaced: (id) => !!memory.get(id)?.supersededBy,
  })
  memory.close()
  return {
    id: testCase.id,
    category: testCase.category,
    memory: memoryEnabled,
    pass: !failures.length,
    failures,
    outcome,
    said,
    costUsd: row?.usage?.costUsd ?? 0,
    seconds: (Date.now() - started) / 1000,
  }
}

async function inParallel<T>(jobs: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const worker = async () => {
    for (let index = next++; index < jobs.length; index = next++) {
      const job = jobs[index]
      if (job) results[index] = await job()
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

const rate = (pass: number, total: number) =>
  total ? `${pass}/${total}（${Math.round((pass / total) * PERCENT)}%）` : '-'

export function renderResults(results: readonly CaseResult[]): string {
  const count = (rows: readonly CaseResult[], memory: boolean) => {
    const matching = rows.filter((row) => row.memory === memory)
    return rate(matching.filter((row) => row.pass).length, matching.length)
  }
  const categories = [...new Set(results.map((row) => row.category))]
  const lines = ['| 类别 | 无记忆 | 有记忆 |', '|---|---|---|']
  for (const category of categories) {
    const rows = results.filter((row) => row.category === category)
    lines.push(`| ${category} | ${count(rows, false)} | ${count(rows, true)} |`)
  }
  lines.push(`| **合计** | **${count(results, false)}** | **${count(results, true)}** |`, '')
  const cost = results.reduce((sum, row) => sum + row.costUsd, 0)
  lines.push(`Leader 牌价合计 $${cost.toFixed(3)}。`, '', '## 没通过的', '')
  for (const row of results.filter((item) => !item.pass)) {
    lines.push(`- **${row.id}**（${row.memory ? '有记忆' : '无记忆'}）：${row.failures.join('；')}`)
    lines.push(`  - 回复：${row.said.replace(/\s+/g, ' ').slice(0, 200) || '（无）'}`)
  }
  return `${lines.join('\n')}\n`
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { only: { type: 'string' }, concurrency: { type: 'string' }, noise: { type: 'string' } },
    allowPositionals: true,
  })
  const [output] = positionals
  if (!output) throw new Error('Usage: memory-eval <output directory> [--only id] [--concurrency n]')
  mkdirSync(output, { recursive: true })
  const llm = new ClaudeCli(leaderSettings(), mkdtempSync(join(tmpdir(), 'memory-eval-cwd-')))
  const cases = CASES.filter((item) => !values.only || item.id === values.only)
  const noise = Number(values.noise ?? 0)
  const jobs = cases.flatMap((testCase) =>
    (noise ? [true] : [false, true]).map((memoryEnabled) => async () => {
      const home = mkdtempSync(join(tmpdir(), 'memory-eval-'))
      try {
        const result = await runCase(testCase, llm, memoryEnabled, home, noise)
        console.log(
          `${result.pass ? 'PASS' : 'FAIL'} ${result.id} memory=${memoryEnabled} ${result.outcome} $${result.costUsd.toFixed(3)}`,
        )
        return result
      } finally {
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    }),
  )
  const results = await inParallel(jobs, Number(values.concurrency ?? DEFAULT_CONCURRENCY))
  const stem = noise ? `results-noise-${noise}` : 'results'
  writeFileSync(join(output, `${stem}.json`), `${JSON.stringify(results, null, 2)}\n`)
  const rendered = renderResults(results)
  writeFileSync(join(output, `${stem}.md`), rendered)
  console.log(rendered)
}

if (process.argv[1]?.endsWith('memory-eval.js')) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
