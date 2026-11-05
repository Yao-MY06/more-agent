/**
 * Assembles what a Leader call sees of the past, by program and without a model call. Nothing is kept between calls, so a call
 * costs the same after a year as on the first day, and a restart loses nothing.
 */
import type { Store } from '../../vendor/dsh-superagent/src/app/store.ts'
import { type Candidate, type Ticket, ticketStage } from '../../vendor/dsh-superagent/src/core/index.ts'
import type { MemoryEntry, MemoryStore } from '../memory/store.ts'
import type { LeaderContext } from './prompt.ts'

const RECENT_ENDED_TICKETS = 15
const MAX_OPEN_TICKETS = 20
/** With 300 unrelated records a decision made over three sessions ranked as low as 6th; three more cost a fraction of a cent a call. */
const MAX_MEMORY_ENTRIES = 8
const MAX_RULES = 10
/** Long enough for most notes; a longer one says it was cut, and recall reads the rest. */
const MEMORY_TEXT_CHARS = 600
const TITLE_CHARS = 100

export interface ContextHost {
  store: Pick<Store, 'tickets' | 'decisions'>
  memory: Pick<MemoryStore, 'search' | 'pinned'>
  /** False for measuring what memory is worth: the card keeps its shape, with nothing in it. */
  enabled: boolean
}

export function memoryCard(entry: MemoryEntry): object {
  const { id, at, scope, origin, pinned, refs, body } = entry
  return {
    id,
    at,
    scope,
    origin,
    ...(pinned ? { pinned } : {}),
    ...(refs?.length ? { refs } : {}),
    text: body.slice(0, MEMORY_TEXT_CHARS),
    ...(body.length > MEMORY_TEXT_CHARS ? { truncated: `read memory:${id} for the rest` } : {}),
  }
}

function ticketCard(host: ContextHost, ticket: Ticket): object {
  const audit = host.store.decisions.get(ticket.decisionId)?.audit as { project?: string } | undefined
  return {
    id: ticket.id,
    title: ticket.title.slice(0, TITLE_CHARS),
    project: audit?.project ?? null,
    stage: ticketStage(ticket).stage,
    ...(ticket.ended ? { outcome: ticket.ended.outcome, ended_at: ticket.ended.at } : {}),
    ...(ticket.attention ? { question: ticket.attention.question } : {}),
  }
}

function workOf(host: ContextHost): object[] {
  const open = host.store.tickets.open().slice(0, MAX_OPEN_TICKETS)
  const ended = host.store.tickets
    .list()
    .filter((ticket) => ticket.ended)
    .slice(0, RECENT_ENDED_TICKETS)
  return [...open, ...ended].map((ticket) => ticketCard(host, ticket))
}

const requestText = (candidate: Candidate): string => candidate.triggers.map((trigger) => trigger.text).join('\n')

export function buildContext(
  host: ContextHost,
  candidate: Candidate,
  recalled: readonly object[],
  recallAllowed: boolean,
): LeaderContext {
  if (!host.enabled) return { work: [], rules: [], memory: [], recalled: [], recallAllowed: false }
  const inForce = host.memory.pinned()
  const rules = inForce.slice(0, MAX_RULES)
  const shown = new Set(rules.map((rule) => rule.id))
  const memory = host.memory
    .search(requestText(candidate), { limit: MAX_MEMORY_ENTRIES + shown.size })
    .filter((hit) => !shown.has(hit.id))
    .slice(0, MAX_MEMORY_ENTRIES)
  return {
    work: workOf(host),
    rules: rules.map(memoryCard),
    rulesOmitted: inForce.length - rules.length,
    memory: memory.map(memoryCard),
    recalled,
    recallAllowed,
  }
}

/** Ids a Leader's answer may point at, taken from the very card it saw. */
export function shownIds(context: LeaderContext): { ticketIds: string[]; memoryIds: string[] } {
  const idsOf = (items: readonly object[]) =>
    items.flatMap((item) => {
      const { id } = item as { id?: unknown }
      return typeof id === 'string' ? [id] : []
    })
  const recalledMemory = context.recalled.flatMap((item) => {
    const { ref } = item as { ref?: unknown }
    return typeof ref === 'string' && ref.startsWith('memory:') ? [ref.slice('memory:'.length)] : []
  })
  const recalledTickets = context.recalled.flatMap((item) => {
    const { ref } = item as { ref?: unknown }
    return typeof ref === 'string' && ref.startsWith('ticket:') ? [ref.slice('ticket:'.length)] : []
  })
  return {
    ticketIds: [...idsOf(context.work), ...recalledTickets],
    memoryIds: [...idsOf(context.rules), ...idsOf(context.memory), ...idsOf(context.recalled), ...recalledMemory],
  }
}
