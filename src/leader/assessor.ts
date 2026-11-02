/** Implements the Engine's Assessor port with one stateless Leader call per Eval, through the durable effect queue. */
import type { Effects } from '../../vendor/dsh-superagent/src/app/effects.ts'
import type { Store } from '../../vendor/dsh-superagent/src/app/store.ts'
import {
  type Assessor,
  type Candidate,
  type Engine,
  key,
  type Outbox,
  type Trigger,
} from '../../vendor/dsh-superagent/src/core/index.ts'
import { LEADER_CONCURRENCY, LEADER_RETRY_MS } from '../config.ts'
import type { Llm } from '../llm/llm.ts'
import type { Project } from '../projects.ts'
import { buildCard, leaderSystemPrompt } from './prompt.ts'
import { parseVerdict, toOutcome, verdictJsonSchema } from './verdict.ts'

export interface LeaderHost {
  engine(): Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide'>
  effects: Pick<Effects, 'enqueue' | 'handle'>
  store: Pick<Store, 'atomic'>
  outbox: Pick<Outbox, 'send'>
  llm: Llm
  projects(): Project[]
  history(candidate: Candidate): Trigger[]
  lifetime: AbortSignal
}

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
    const projects = host.projects()
    const request = {
      system: leaderSystemPrompt(projects),
      user: buildCard(candidate, host.history(candidate)),
      schema: verdictJsonSchema(),
    }
    const { output, usage } = await host.llm.complete(request, host.lifetime)
    const verdict = parseVerdict(
      output,
      projects.map((project) => project.id),
    )
    // The Eval may have expired during the call, so only decide one that is still this call's.
    if (host.engine().candidate(triggerId)?.evalId !== evalId) return
    const channel = candidate.triggers[0]?.channel
    // In one transaction, so a crash cannot record the Decision and lose the question the person is waiting for.
    host.store.atomic(() => {
      host.engine().decide(triggerId, { ...toOutcome(verdict, usage), evalId })
      if (verdict.action === 'clarify' && verdict.question && channel) {
        host.outbox.send({ id: key('clarify', triggerId), channel, text: verdict.question, kind: 'reply' })
      }
    })
  }
}
