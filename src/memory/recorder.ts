/**
 * Writes memory through the durable effect queue, inside the caller's transaction: what happened and the memory of it commit
 * together, and a crash replays the write, which the store takes once. Entries are verbatim on purpose: a person's words and a
 * manager's summary, never a model's rewording, and nothing a worker or the network produced.
 */
import type { Effects } from '../../vendor/dsh-superagent/src/app/effects.ts'
import { key, type Ticket, type Trigger, threadKey } from '../../vendor/dsh-superagent/src/core/index.ts'
import type { MemoryInput, MemoryStore } from './store.ts'

/** The memory a message becomes: the same id every time, so that a retried write never makes a second one. */
export const messageMemoryId = (triggerId: string): string => `message-${triggerId}`

export const GLOBAL_SCOPE = 'global'
export const projectScope = (projectId: string): string => `project:${projectId}`

export interface RecorderHost {
  effects: Pick<Effects, 'enqueue' | 'handle'>
  memory: Pick<MemoryStore, 'record'>
}

export class MemoryRecorder {
  private readonly host: RecorderHost
  constructor(host: RecorderHost) {
    this.host = host
    // `notice` belongs to upstream's main Session, which this project does not have, so its queue is free for this.
    host.effects.handle(
      'notice',
      async ({ value }) => {
        host.memory.record(value as unknown as MemoryInput)
      },
      { ordered: true },
    )
  }

  record(input: MemoryInput): void {
    this.host.effects.enqueue('notice', input.id, { value: { ...input }, summary: '' })
  }

  /** A person's message, in their own words. */
  message(
    trigger: Trigger,
    scope: string,
    options: Pick<MemoryInput, 'pinned' | 'supersedes'> & { ticketId?: string } = {},
  ): void {
    const { ticketId, ...rest } = options
    const refs = [
      `trigger:${trigger.id}`,
      ...trigger.threads.map((thread) => `thread:${threadKey(thread)}`),
      ...(ticketId ? [`ticket:${ticketId}`] : []),
    ]
    this.record({
      id: messageMemoryId(trigger.id),
      at: trigger.at,
      origin: 'human',
      scope,
      refs,
      body: trigger.text,
      ...rest,
    })
  }

  /** What a manager reported to the person. A failure is left out: it describes one turn, not something worth learning from. */
  report(ticket: Ticket, scope: string, report: { state: string; summary: string; question?: string }): void {
    if (report.state === 'failed') return
    const question = report.question ? `\n问题：${report.question}` : ''
    this.record({
      id: key('report', ticket.id, report.state, report.summary, report.question ?? ''),
      at: new Date().toISOString(),
      origin: 'agent',
      scope,
      refs: [`ticket:${ticket.id}`, ...ticket.origin.triggerIds.map((id) => `trigger:${id}`)],
      body: `工单「${ticket.title}」（${report.state}）：${report.summary}${question}`,
    })
  }
}
