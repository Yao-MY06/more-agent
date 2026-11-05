/**
 * Follows a reference to the raw evidence behind a memory. Everything carries the ids of what it relates to, so a Leader can go
 * from a memory to its Ticket to the messages around it, one hop at a time: upstream's Chain of Recall.
 */
import type { Store } from '../../vendor/dsh-superagent/src/app/store.ts'
import { latestAssignment, ticketStage } from '../../vendor/dsh-superagent/src/core/index.ts'
import type { MemoryStore } from './store.ts'

export const REF_PATTERN = /^(memory|ticket|trigger|thread):.{1,200}$/
/** Enough to answer from, and small enough that one recall stays cheap; the rest stays on disk. */
const RECALL_TEXT_CHARS = 2000
const THREAD_MESSAGES = 10
const THREAD_MESSAGE_CHARS = 200

export interface RefHost {
  store: Pick<Store, 'tickets' | 'triggers' | 'decisions' | 'threads' | 'read'>
  memory: Pick<MemoryStore, 'get'>
}

const clip = (text: string, chars = RECALL_TEXT_CHARS) => ({
  text: text.slice(0, chars),
  ...(text.length > chars ? { truncated: true } : {}),
})

function readMemory(host: RefHost, id: string): object | undefined {
  const entry = host.memory.get(id)
  if (!entry) return undefined
  const { body, ...rest } = entry
  return { ...rest, ...clip(body) }
}

function readTicket(host: RefHost, id: string): object | undefined {
  const ticket = host.store.tickets.get(id)
  if (!ticket) return undefined
  const audit = host.store.decisions.get(ticket.decisionId)?.audit as { project?: string } | undefined
  const report = latestAssignment(ticket)?.report
  return {
    title: ticket.title,
    project: audit?.project ?? null,
    stage: ticketStage(ticket).stage,
    outcome: ticket.ended?.outcome ?? null,
    question: ticket.attention?.question ?? null,
    scope: ticket.mandate.scope,
    report: report ? { state: report.state, at: report.at, ...clip(report.summary) } : null,
    triggers: ticket.origin.triggerIds.map((trigger) => `trigger:${trigger}`),
    messages: ticket.inputs.flatMap((input) => (input.kind === 'trigger' ? [`trigger:${input.triggerId}`] : [])),
  }
}

function readTrigger(host: RefHost, id: string): object | undefined {
  const trigger = host.store.triggers.get(id)
  if (!trigger) return undefined
  const disposition = host.store.triggers.disposition(id)
  return {
    at: trigger.at,
    ...clip(trigger.text),
    threads: trigger.threads.map((thread) => `thread:${thread.source}:${thread.id}`),
    tickets: (disposition?.fanout ?? []).map((ticket) => `ticket:${ticket}`),
  }
}

function readThread(host: RefHost, key: string): object | undefined {
  const thread = host.store.threads.get(key)
  if (!thread) return undefined
  return {
    tickets: thread.subscriptions.map((ticket) => `ticket:${ticket}`),
    messages: host.store.read.threadTriggers(key, THREAD_MESSAGES).map((trigger) => ({
      ref: `trigger:${trigger.id}`,
      at: trigger.at,
      text: trigger.text.slice(0, THREAD_MESSAGE_CHARS),
    })),
  }
}

/** @returns what the reference points at, or a note that nothing does: a wrong id should not fail the whole turn. */
export function readRef(host: RefHost, ref: string): object {
  const at = ref.indexOf(':')
  const kind = ref.slice(0, at)
  const id = ref.slice(at + 1)
  const readers: Record<string, (host: RefHost, id: string) => object | undefined> = {
    memory: readMemory,
    ticket: readTicket,
    trigger: readTrigger,
    thread: readThread,
  }
  const found = readers[kind]?.(host, id)
  return found ? { ref, ...found } : { ref, missing: true }
}
