/** Read-only views of what the Leader decided, for a person to check. They never need the runner's lock. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { storeReads } from '../vendor/dsh-superagent/src/app/store-read.ts'
import { type Decision, reasonText, type Trigger } from '../vendor/dsh-superagent/src/core/index.ts'
import type { Paths } from './config.ts'
import type { LlmUsage } from './llm/llm.ts'

const MAX_DECISIONS = 10_000
const NOT_A_PROJECT = ['attach', 'answer', 'remember', 'clarify', 'ignore', 'unavailable']
const PERCENT = 100
const MS_PER_SECOND = 1000
const TEXT_PREVIEW_CHARS = 48
const ID_COLUMN_CHARS = 28
const OUTCOME_COLUMN_CHARS = 16

const ReviewSchema = z
  .object({
    triggerId: z.string().min(1),
    verdict: z.enum(['ok', 'wrong']),
    note: z.string().optional(),
    at: z.string(),
  })
  .strict()
export type Review = z.infer<typeof ReviewSchema>

interface Audit {
  action?: string
  project?: string | null
  question?: string | null
  confidence?: number
  usage?: LlmUsage
}

export interface DecisionRow {
  triggerId: string
  text: string
  /** The project it would go to, or `clarify`, `ignore` or `unavailable`. */
  outcome: string
  /** What the Ticket was accepted to do, which is what a manager is told. */
  scope?: string
  expected?: string
  matchesExpected?: boolean
  confidence?: number
  reason: string
  question?: string
  wouldSay?: string
  usage?: LlmUsage
  review?: Review
}

export interface Summary {
  decisions: number
  routed: number
  attached: number
  answered: number
  remembered: number
  clarified: number
  ignored: number
  unavailable: number
  withExpected: number
  matched: number
  reviewedOk: number
  reviewedWrong: number
  /** Follow-ups delivered straight to a Ticket, without a Leader call. */
  direct: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  averageSeconds: number
}

export interface Status {
  spoolWaiting: number
  triggers: number
  activeThreads: number
  effects: number
  tickets: number
  wouldSay: number
  sent: number
}

function withDatabase<T>(paths: Paths, empty: T, read: (db: DatabaseSync) => T): T {
  if (!existsSync(paths.db)) return empty
  const db = new DatabaseSync(paths.db, { readOnly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function count(db: DatabaseSync, sql: string): number {
  return Number(db.prepare(sql).get()?.n ?? 0)
}

export function appendReview(paths: Paths, review: Review): void {
  mkdirSync(dirname(paths.reviews), { recursive: true })
  appendFileSync(paths.reviews, `${JSON.stringify(ReviewSchema.parse(review))}\n`)
}

/** The latest review of each Trigger wins, so a person can change their mind. */
export function loadReviews(paths: Paths): Map<string, Review> {
  if (!existsSync(paths.reviews)) return new Map()
  const lines = readFileSync(paths.reviews, 'utf8').split('\n').filter(Boolean)
  return new Map(lines.map((line) => ReviewSchema.parse(JSON.parse(line))).map((review) => [review.triggerId, review]))
}

export function outcomeOf(decision: Pick<Decision, 'kind' | 'audit'>): string {
  const audit = decision.audit as Audit | undefined
  if (decision.kind === 'accept') return audit?.project ?? 'accept'
  return decision.kind === 'ignore' && audit?.action ? audit.action : decision.kind
}

function triggerOf(db: DatabaseSync, id: string): Trigger | undefined {
  const row = db.prepare('SELECT value FROM trigger WHERE id = ?').get(id)
  return row ? (JSON.parse(String(row.value)) as Trigger) : undefined
}

function wouldSayOf(db: DatabaseSync, ticketId: string | undefined): string | undefined {
  if (!ticketId) return undefined
  const row = db
    .prepare("SELECT json_extract(value, '$.text') AS text FROM outbox WHERE json_extract(value, '$.ticketId') = ?")
    .get(ticketId)
  return row ? String(row.text) : undefined
}

function toRow(db: DatabaseSync, decision: Decision, id: string, reviews: Map<string, Review>): DecisionRow {
  const audit = decision.audit as Audit | undefined
  const trigger = triggerOf(db, id)
  const outcome = outcomeOf(decision)
  const expected = trigger?.meta.expected as string | undefined
  const wouldSay = wouldSayOf(db, decision.ticketId)
  const review = reviews.get(id)
  return {
    triggerId: id,
    text: trigger?.text ?? '',
    outcome,
    reason: reasonText(decision.reason),
    ...(decision.mandate ? { scope: decision.mandate.scope } : {}),
    ...(expected ? { expected, matchesExpected: outcome === expected } : {}),
    ...(audit?.confidence === undefined ? {} : { confidence: audit.confidence }),
    ...(audit?.question ? { question: audit.question } : {}),
    ...(wouldSay ? { wouldSay } : {}),
    ...(audit?.usage ? { usage: audit.usage } : {}),
    ...(review ? { review } : {}),
  }
}

/** Oldest first, one row per Trigger of each Decision. */
export function decisionRows(paths: Paths): DecisionRow[] {
  const reviews = loadReviews(paths)
  return withDatabase<DecisionRow[]>(paths, [], (db) =>
    storeReads(db)
      .recentDecisions(0, MAX_DECISIONS)
      .reverse()
      .flatMap((decision) => decision.triggerIds.map((id) => toRow(db, decision, id, reviews))),
  )
}

function directCount(paths: Paths): number {
  return withDatabase(paths, 0, (db) =>
    count(db, "SELECT COUNT(*) AS n FROM disposition WHERE json_array_length(value, '$.fanout') > 0"),
  )
}

export function summarize(rows: readonly DecisionRow[], direct: number): Summary {
  const isProject = (row: DecisionRow) => !NOT_A_PROJECT.includes(row.outcome)
  const used = rows.flatMap((row) => (row.usage ? [row.usage] : []))
  const total = (read: (usage: LlmUsage) => number) => used.reduce((sum, usage) => sum + read(usage), 0)
  return {
    decisions: rows.length,
    routed: rows.filter(isProject).length,
    attached: rows.filter((row) => row.outcome === 'attach').length,
    answered: rows.filter((row) => row.outcome === 'answer').length,
    remembered: rows.filter((row) => row.outcome === 'remember').length,
    clarified: rows.filter((row) => row.outcome === 'clarify').length,
    ignored: rows.filter((row) => row.outcome === 'ignore').length,
    unavailable: rows.filter((row) => row.outcome === 'unavailable').length,
    withExpected: rows.filter((row) => row.expected).length,
    matched: rows.filter((row) => row.matchesExpected).length,
    reviewedOk: rows.filter((row) => row.review?.verdict === 'ok').length,
    reviewedWrong: rows.filter((row) => row.review?.verdict === 'wrong').length,
    direct,
    inputTokens: total((usage) => usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens),
    outputTokens: total((usage) => usage.outputTokens),
    costUsd: total((usage) => usage.costUsd),
    averageSeconds: used.length ? total((usage) => usage.durationMs) / used.length / MS_PER_SECOND : 0,
  }
}

export function readSummary(paths: Paths): { rows: DecisionRow[]; summary: Summary } {
  const rows = decisionRows(paths)
  return { rows, summary: summarize(rows, directCount(paths)) }
}

export function readStatus(paths: Paths, spoolWaiting: number): Status {
  const empty = { triggers: 0, activeThreads: 0, effects: 0, tickets: 0, wouldSay: 0, sent: 0 }
  const counts = withDatabase(paths, empty, (db) => ({
    triggers: count(db, 'SELECT COUNT(*) AS n FROM trigger'),
    activeThreads: count(db, 'SELECT COUNT(*) AS n FROM thread WHERE active = 1'),
    effects: count(db, 'SELECT COUNT(*) AS n FROM effect'),
    tickets: count(db, 'SELECT COUNT(*) AS n FROM ticket'),
    wouldSay: count(db, "SELECT COUNT(*) AS n FROM outbox WHERE json_extract(value, '$.status') = 'pending'"),
    sent: count(db, "SELECT COUNT(*) AS n FROM outbox WHERE json_extract(value, '$.status') = 'sent'"),
  }))
  return { spoolWaiting, ...counts }
}

export function triggerExists(paths: Paths, id: string): boolean {
  return withDatabase(paths, false, (db) => !!triggerOf(db, id))
}

function mark(row: DecisionRow): string {
  if (row.review) return row.review.verdict === 'ok' ? '对' : '错'
  if (row.matchesExpected === undefined) return '·'
  return row.matchesExpected ? '✓' : '✗'
}

function renderRow(row: DecisionRow): string {
  const preview = row.text.replace(/\s+/g, ' ').slice(0, TEXT_PREVIEW_CHARS)
  const expected = row.expected && !row.matchesExpected ? ` (预期 ${row.expected})` : ''
  return `${mark(row)} ${row.triggerId.padEnd(ID_COLUMN_CHARS)} ${row.outcome.padEnd(OUTCOME_COLUMN_CHARS)} ${preview}${expected}`
}

export function renderReport({ rows, summary }: { rows: readonly DecisionRow[]; summary: Summary }): string {
  const matchRate = summary.withExpected ? Math.round((summary.matched / summary.withExpected) * PERCENT) : 0
  const unreviewed = summary.decisions - summary.reviewedOk - summary.reviewedWrong
  return [
    `决策 ${summary.decisions} 条：路由 ${summary.routed}，接旧单 ${summary.attached}，回答 ${summary.answered}，记住 ${summary.remembered}，澄清 ${summary.clarified}，忽略 ${summary.ignored}，不可用 ${summary.unavailable}`,
    `预期命中 ${summary.matched}/${summary.withExpected}（${matchRate}%）`,
    `人工核对：对 ${summary.reviewedOk}，错 ${summary.reviewedWrong}，未核对 ${unreviewed}`,
    `后续消息直达 ${summary.direct} 条（未调用 Leader）`,
    `Leader 用量：输入 ${summary.inputTokens} token，输出 ${summary.outputTokens} token，牌价 $${summary.costUsd.toFixed(3)}，平均 ${summary.averageSeconds.toFixed(1)} 秒/次`,
    '',
    ...rows.map(renderRow),
  ].join('\n')
}
