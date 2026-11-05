/** Implements the Engine's Assessor port with stateless Leader calls, through the durable effect queue. */
import type { Effects } from '../../vendor/dsh-superagent/src/app/effects.ts'
import type { Store } from '../../vendor/dsh-superagent/src/app/store.ts'
import {
  type Assessor,
  type Candidate,
  type Decision,
  type Engine,
  key,
  type Outbox,
  type Trigger,
  UserError,
} from '../../vendor/dsh-superagent/src/core/index.ts'
import { LEADER_CONCURRENCY, LEADER_RETRY_MS } from '../config.ts'
import type { Llm, LlmUsage } from '../llm/llm.ts'
import { GLOBAL_SCOPE, type MemoryRecorder, projectScope } from '../memory/recorder.ts'
import type { Project } from '../projects.ts'
import { projectOfTicket } from '../ticket-project.ts'
import { shownIds } from './context.ts'
import { buildCard, type LeaderContext, leaderSystemPrompt } from './prompt.ts'
import { auditOf, memoryScopeOf, parseVerdict, toOutcome, type Verdict, verdictJsonSchema } from './verdict.ts'

const ATTACH_REFUSED = '那张工单已经被停止，不能接着做。要新开一张吗？'
/** Bounded, so a Leader cannot spend without limit on one request. Each recall is one more call. */
const MAX_RECALLS = 2

export interface LeaderHost {
  engine(): Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide' | 'attach'>
  effects: Pick<Effects, 'enqueue' | 'handle'>
  store: Pick<Store, 'atomic' | 'tickets' | 'decisions' | 'triggers'>
  outbox: Pick<Outbox, 'send'>
  llm: Llm
  projects(): Project[]
  history(candidate: Candidate): Trigger[]
  context(candidate: Candidate, recalled: readonly object[], recallAllowed: boolean): LeaderContext
  recall(query: string | null, refs: readonly string[]): object[]
  recorder: Pick<MemoryRecorder, 'message'>
  lifetime: AbortSignal
}

const addUsage = (total: LlmUsage | undefined, usage: LlmUsage): LlmUsage =>
  total
    ? {
        inputTokens: total.inputTokens + usage.inputTokens,
        cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
        costUsd: total.costUsd + usage.costUsd,
        durationMs: total.durationMs + usage.durationMs,
      }
    : usage

export class LeaderAssessor implements Assessor {
  private readonly host: LeaderHost
  constructor(host: LeaderHost) {
    this.host = host
    host.effects.handle('assessment', ({ triggerId }, evalId) => this.assess(triggerId, evalId), {
      limit: () => LEADER_CONCURRENCY,
      retry: LEADER_RETRY_MS,
    })
  }

  request(candidate: Candidate): void {
    const [first] = candidate.triggers
    if (first) this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: first.id })
  }

  /** Failures throw so the effect retries with backoff; the Eval's deadline bounds how long, then records it unavailable. */
  private async assess(triggerId: string, evalId: string): Promise<void> {
    const { host } = this
    const candidate = host.engine().candidate(triggerId)
    // A restart can replay this effect after its Decision landed: a finished Eval has nothing left to judge.
    if (candidate?.evalId !== evalId) return
    host.engine().candidateDelivered(evalId)
    const { verdict, usage } = await this.judge(candidate)
    // The Eval may have expired during the call, so only decide one that is still this call's.
    if (host.engine().candidate(triggerId)?.evalId !== evalId) return
    // In one transaction, so a crash cannot record the Decision and lose what the person is waiting for or what to remember.
    host.store.atomic(() => this.apply(candidate, triggerId, evalId, verdict, usage))
  }

  /** Calls the Leader, and again with what it asks to look up, up to the limit. */
  private async judge(candidate: Candidate): Promise<{ verdict: Verdict; usage: LlmUsage }> {
    const { host } = this
    const recalled: object[] = []
    let usage: LlmUsage | undefined
    for (let hop = 0; ; hop++) {
      const projects = host.projects()
      const recallAllowed = hop < MAX_RECALLS
      const context = host.context(candidate, recalled, recallAllowed)
      const request = {
        system: leaderSystemPrompt(projects),
        user: buildCard(candidate, host.history(candidate), context),
        schema: verdictJsonSchema(),
      }
      const result = await host.llm.complete(request, host.lifetime)
      usage = addUsage(usage, result.usage)
      const verdict = parseVerdict(result.output, {
        projectIds: projects.map((project) => project.id),
        recallAllowed,
        ...shownIds(context),
      })
      if (verdict.action !== 'recall') return { verdict, usage }
      recalled.push(...host.recall(verdict.recall_query, verdict.recall_refs))
    }
  }

  private apply(candidate: Candidate, triggerId: string, evalId: string, verdict: Verdict, usage: LlmUsage): void {
    if (verdict.action === 'attach' && this.attach(candidate, triggerId, verdict, usage)) return
    const { engine, recorder } = this.host
    const decision = engine().decide(triggerId, { ...toOutcome(verdict, usage), evalId })
    if (verdict.action === 'answer') this.say(candidate, 'answer', triggerId, verdict.reply)
    if (verdict.action === 'clarify') this.say(candidate, 'clarify', triggerId, verdict.question)
    if (verdict.action === 'remember') this.say(candidate, 'remembered', triggerId, verdict.reply)
    if (verdict.action === 'attach') this.say(candidate, 'attach-refused', triggerId, ATTACH_REFUSED)
    for (const trigger of candidate.triggers) {
      if (verdict.action === 'answer' || verdict.action === 'ignore' || verdict.action === 'attach') continue
      recorder.message(trigger, this.scopeOf(verdict), {
        ...(verdict.action === 'remember' ? { pinned: true } : {}),
        ...(verdict.action === 'remember' && verdict.supersedes ? { supersedes: verdict.supersedes } : {}),
        ...this.ticketRef(decision),
      })
    }
  }

  private ticketRef(decision: Decision): { ticketId?: string } {
    return decision.ticketId ? { ticketId: decision.ticketId } : {}
  }

  private scopeOf(verdict: Verdict): string {
    if (verdict.action === 'route' && verdict.project) return projectScope(verdict.project)
    return verdict.action === 'remember' ? memoryScopeOf(verdict) : GLOBAL_SCOPE
  }

  /** @returns false when the Ticket cannot take it, such as one a person stopped, which leaves the person to decide. */
  private attach(candidate: Candidate, triggerId: string, verdict: Verdict, usage: LlmUsage): boolean {
    const { store, engine, recorder, projects } = this.host
    const ticketId = verdict.ticket ?? ''
    try {
      engine().attach(ticketId, triggerId)
    } catch (error) {
      if (error instanceof UserError) return false
      throw error
    }
    // Upstream records this Decision itself and knows nothing of the audit, which is where a call's cost is kept.
    const decisionId = store.triggers.disposition(triggerId)?.decisionId
    const decision = decisionId ? store.decisions.get(decisionId) : undefined
    if (decision) store.decisions.save({ ...decision, audit: auditOf(verdict, usage) })
    this.say(candidate, 'attached', triggerId, verdict.acknowledgement)
    const ticket = store.tickets.get(ticketId)
    const project = ticket && projectOfTicket(ticket, store.decisions, projects())
    const scope = project ? projectScope(project.id) : GLOBAL_SCOPE
    for (const trigger of candidate.triggers) recorder.message(trigger, scope, { ticketId })
    return true
  }

  private say(candidate: Candidate, kind: string, triggerId: string, text: string | null): void {
    const channel = candidate.triggers[0]?.channel
    if (text && channel) this.host.outbox.send({ id: key(kind, triggerId), channel, text, kind: 'reply' })
  }
}
