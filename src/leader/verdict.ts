/** What the Leader may answer, checked in code: the model judges, and the host decides whether the answer stands. */
import { z } from 'zod'
import type { AssessmentOutcome } from '../../vendor/dsh-superagent/src/core/index.ts'
import type { LlmUsage } from '../llm/llm.ts'
import { GLOBAL_SCOPE, projectScope } from '../memory/recorder.ts'
import { REF_PATTERN } from '../memory/refs.ts'

const TITLE_CHARS = 160
const SCOPE_CHARS = 1500
const REASON_CHARS = 500
const SENTENCE_CHARS = 300
const REPLY_CHARS = 1000
const RECALL_QUERY_CHARS = 300
const MAX_RECALL_REFS = 5

export const VerdictSchema = z
  .object({
    action: z.enum(['route', 'attach', 'answer', 'remember', 'recall', 'clarify', 'ignore']),
    project: z.string().nullable(),
    ticket: z.string().nullable(),
    title: z.string().trim().min(1).max(TITLE_CHARS),
    scope: z.string().trim().max(SCOPE_CHARS),
    reason: z.string().trim().min(1).max(REASON_CHARS),
    acknowledgement: z.string().trim().max(SENTENCE_CHARS).nullable(),
    question: z.string().trim().max(SENTENCE_CHARS).nullable(),
    reply: z.string().trim().max(REPLY_CHARS).nullable(),
    supersedes: z.string().nullable(),
    recall_query: z.string().trim().max(RECALL_QUERY_CHARS).nullable(),
    recall_refs: z.array(z.string().regex(REF_PATTERN)).max(MAX_RECALL_REFS),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export type Verdict = z.infer<typeof VerdictSchema>

export function verdictJsonSchema(): object {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(VerdictSchema)
  return schema
}

/** What this call's card showed. An answer can only point at those: anything else is a mistake, not an instruction. */
export interface VerdictContext {
  projectIds: readonly string[]
  ticketIds: readonly string[]
  memoryIds: readonly string[]
  recallAllowed: boolean
}

function requireShown(verdict: Verdict, context: VerdictContext): void {
  if (verdict.action === 'route' && !context.projectIds.includes(verdict.project ?? '')) {
    throw new Error(`The Leader routed to an unregistered project: ${verdict.project}`)
  }
  if (verdict.action === 'attach' && !context.ticketIds.includes(verdict.ticket ?? '')) {
    throw new Error(`The Leader attached to a ticket the card did not show: ${verdict.ticket}`)
  }
  if (verdict.action === 'remember' && verdict.project !== null && !context.projectIds.includes(verdict.project)) {
    throw new Error(`The Leader scoped a memory to an unregistered project: ${verdict.project}`)
  }
  if (verdict.supersedes !== null && !context.memoryIds.includes(verdict.supersedes)) {
    throw new Error(`The Leader superseded a memory the card did not show: ${verdict.supersedes}`)
  }
}

/**
 * @throws when the answer breaks the schema or points at something the card did not show; the assessment then retries rather
 * than records something that cannot be right.
 */
export function parseVerdict(output: unknown, context: VerdictContext): Verdict {
  const verdict = VerdictSchema.parse(output)
  requireShown(verdict, context)
  if (verdict.action === 'clarify' && !verdict.question)
    throw new Error('The Leader asked to clarify without a question')
  if ((verdict.action === 'answer' || verdict.action === 'remember') && !verdict.reply) {
    throw new Error(`The Leader chose ${verdict.action} with no reply`)
  }
  if (verdict.action === 'recall') {
    if (!context.recallAllowed) throw new Error('The Leader has no recalls left')
    if (!verdict.recall_query && !verdict.recall_refs.length) throw new Error('The Leader recalled nothing')
  }
  return verdict
}

/** Where a memory goes: a project the Leader named, or everywhere. */
export const memoryScopeOf = (verdict: Pick<Verdict, 'project'>): string =>
  verdict.project === null ? GLOBAL_SCOPE : projectScope(verdict.project)

export function auditOf(verdict: Verdict, usage: LlmUsage): Record<string, unknown> {
  return {
    action: verdict.action,
    project: verdict.action === 'route' || verdict.action === 'remember' ? verdict.project : null,
    ticket: verdict.action === 'attach' ? verdict.ticket : null,
    question: verdict.action === 'clarify' ? verdict.question : null,
    reply: verdict.action === 'answer' ? verdict.reply : null,
    confidence: verdict.confidence,
    usage,
  }
}

/** A route is what starts a Ticket; every other action ends the Eval without one. */
export function toOutcome(verdict: Verdict, usage: LlmUsage): AssessmentOutcome {
  const audit = auditOf(verdict, usage)
  if (verdict.action !== 'route') return { kind: 'ignore', reason: verdict.reason, audit }
  return {
    kind: 'accept',
    title: verdict.title,
    scope: verdict.scope,
    reason: verdict.reason,
    audit,
    note: `project: ${verdict.project}`,
    ...(verdict.acknowledgement ? { acknowledgement: verdict.acknowledgement } : {}),
  }
}
