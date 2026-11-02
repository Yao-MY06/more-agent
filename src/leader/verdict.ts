/** What the Leader may answer, checked in code: the model judges, and the host decides whether the answer stands. */
import { z } from 'zod'
import type { AssessmentOutcome } from '../../vendor/dsh-superagent/src/core/index.ts'
import type { LlmUsage } from '../llm/llm.ts'

const TITLE_CHARS = 160
const SCOPE_CHARS = 1500
const REASON_CHARS = 500
const SENTENCE_CHARS = 300

export const VerdictSchema = z
  .object({
    action: z.enum(['route', 'clarify', 'ignore']),
    project: z.string().nullable(),
    title: z.string().trim().min(1).max(TITLE_CHARS),
    scope: z.string().trim().max(SCOPE_CHARS),
    reason: z.string().trim().min(1).max(REASON_CHARS),
    acknowledgement: z.string().trim().max(SENTENCE_CHARS).nullable(),
    question: z.string().trim().max(SENTENCE_CHARS).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
export type Verdict = z.infer<typeof VerdictSchema>

export function verdictJsonSchema(): object {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(VerdictSchema)
  return schema
}

/**
 * @throws when the answer breaks the schema, routes to a project nobody registered, or clarifies without a question;
 * the assessment then retries rather than records a route that cannot be right.
 */
export function parseVerdict(output: unknown, projectIds: readonly string[]): Verdict {
  const verdict = VerdictSchema.parse(output)
  if (verdict.action === 'route' && !projectIds.includes(verdict.project ?? '')) {
    throw new Error(`The Leader routed to an unregistered project: ${verdict.project}`)
  }
  if (verdict.action === 'clarify' && !verdict.question)
    throw new Error('The Leader asked to clarify without a question')
  return verdict
}

/** M0 keeps the Leader's judgement in the Decision's audit: a route is what would have been dispatched. */
export function toOutcome(verdict: Verdict, usage: LlmUsage): AssessmentOutcome {
  const audit = {
    action: verdict.action,
    project: verdict.action === 'route' ? verdict.project : null,
    question: verdict.action === 'clarify' ? verdict.question : null,
    confidence: verdict.confidence,
    usage,
  }
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
