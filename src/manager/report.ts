/** What a manager turn may report, and how a finished turn process turns into one outcome. */
import { z } from 'zod'
import { SUMMARY_CHARS } from '../config.ts'
import { parseClaudeResult } from '../llm/claude-cli.ts'
import type { TurnView } from './turn.ts'

const QUESTION_CHARS = 1000
const FOLLOWUP_TEXT_CHARS = 500
const OMH_TICKET_PATTERN = /^T\d+$/
const ERROR_EXCERPT_CHARS = 300

export const ManagerReportSchema = z
  .object({
    state: z.enum(['waiting', 'ready', 'blocked', 'dropped']),
    summary: z.string().trim().min(1).max(SUMMARY_CHARS),
    question: z.string().trim().max(QUESTION_CHARS).nullable(),
    wait_for: z.array(z.string().regex(OMH_TICKET_PATTERN)),
    followups: z.array(
      z
        .object({
          trigger_id: z.string().min(1),
          decision: z.enum(['taken_up', 'hand_back']),
          text: z.string().trim().min(1).max(FOLLOWUP_TEXT_CHARS),
        })
        .strict(),
    ),
  })
  .strict()
export type ManagerReport = z.infer<typeof ManagerReportSchema>

export function managerReportJsonSchema(): object {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(ManagerReportSchema)
  return schema
}

/** @throws when the report breaks the schema or its state's rule, so the turn counts as failed rather than half-applied. */
export function parseManagerReport(output: unknown): ManagerReport {
  const report = ManagerReportSchema.parse(output)
  if (report.state === 'blocked' && !report.question) throw new Error('A blocked report must ask a question')
  if (report.state === 'waiting' && !report.wait_for.length)
    throw new Error('A waiting report must name the omh tickets')
  if (report.state !== 'blocked' && report.question) throw new Error(`A ${report.state} report cannot ask a question`)
  return report
}

/**
 * `sessionTotalUsd` is what the CLI reports: on a resumed session, the running total of the whole session, not this turn's
 * cost. Only `usage` is per turn, and it carries no price.
 */
export type TurnOutcome =
  | { kind: 'report'; report: ManagerReport; sessionTotalUsd: number }
  | { kind: 'failure'; reason: string; sessionTotalUsd?: number }
  | { kind: 'session-lost' }
  | { kind: 'killed' }

const SESSION_LOST = /No conversation found/i
const CLI_STOPS: Record<string, string> = { error_max_budget_usd: '这一轮用完了预算上限' }

const CliFailureSchema = z.looseObject({
  subtype: z.string().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
})

/** What the CLI said about a failure, when it said anything readable: it reports its own failures as JSON on stdout. */
function readCliFailure(stdout: string): z.infer<typeof CliFailureSchema> | undefined {
  try {
    return CliFailureSchema.parse(JSON.parse(stdout))
  } catch {
    return undefined
  }
}

function describeFailure(view: TurnView, error: unknown): TurnOutcome {
  const cli = readCliFailure(view.stdout)
  const stopped = cli?.subtype === undefined ? undefined : CLI_STOPS[cli.subtype]
  const said = cli?.result ?? cli?.subtype
  const fallback = view.exitCode ? `退出码 ${view.exitCode}：${excerpt(view)}` : String(error)
  return {
    kind: 'failure',
    reason: stopped ?? `这一轮出错了（${(said ?? fallback).slice(0, ERROR_EXCERPT_CHARS)}）`,
    ...(cli?.total_cost_usd === undefined ? {} : { sessionTotalUsd: cli.total_cost_usd }),
  }
}
const NOT_RUN: Record<string, string> = {
  timeout: '这一轮超过了硬超时',
  'failed-to-start': '这一轮没能启动',
}

function excerpt(view: TurnView): string {
  return (view.stderr || view.stdout || view.error || '').trim().slice(0, ERROR_EXCERPT_CHARS)
}

/** Reads what a finished turn left behind. */
export function parseTurnOutcome(view: TurnView): TurnOutcome {
  if (view.state === 'killed') return { kind: 'killed' }
  if (SESSION_LOST.test(`${view.stderr}\n${view.stdout}`)) return { kind: 'session-lost' }
  const notRun = view.state === undefined ? undefined : NOT_RUN[view.state]
  if (notRun) return { kind: 'failure', reason: `${notRun}：${excerpt(view)}` }
  let result: ReturnType<typeof parseClaudeResult>
  try {
    result = parseClaudeResult(view.stdout)
  } catch (error) {
    return describeFailure(view, error)
  }
  try {
    return { kind: 'report', report: parseManagerReport(result.output), sessionTotalUsd: result.usage.costUsd }
  } catch (error) {
    const detail = String(error).slice(0, ERROR_EXCERPT_CHARS)
    return { kind: 'failure', reason: `这一轮的汇报不合规（${detail}）`, sessionTotalUsd: result.usage.costUsd }
  }
}
