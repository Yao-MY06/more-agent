/** The writes shared by the command line and the local web panel. Both must use the same queue and memory code. */
import { randomUUID } from 'node:crypto'
import type { Paths } from './config.ts'
import { GLOBAL_SCOPE, projectScope } from './memory/recorder.ts'
import type { MemoryStore } from './memory/store.ts'
import { loadProjects } from './projects.ts'
import { writeSpool, writeSpoolCommand } from './spool.ts'
import { readTickets } from './tickets-view.ts'

const DEFAULT_FORGET_REASON = '用户要求忘记'

export type ActionErrorCode = 'E_BAD_REQUEST' | 'E_NOT_FOUND' | 'E_CONFLICT'

export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** thread 不传就新开一个话题。 */
export function submitMessage(
  paths: Paths,
  input: { text: string; thread?: string },
): { triggerId: string; threadKey: string } {
  const id = randomUUID()
  const thread = input.thread ?? id
  writeSpool(paths, {
    id,
    source: 'cli',
    thread,
    text: input.text,
    at: new Date().toISOString(),
  })
  return { triggerId: `cli:${id}`, threadKey: `cli:${thread}` }
}

/** @throws ActionError E_NOT_FOUND：工单不存在；E_CONFLICT：工单已结束 */
export function submitStop(paths: Paths, input: { ticketId: string; reason?: string }): { ticketId: string } {
  const ticket = readTickets(paths).find((row) => row.id === input.ticketId)
  if (!ticket) throw new ActionError('E_NOT_FOUND', `没有这个工单：${input.ticketId}`)
  if (ticket.stage === 'ended') throw new ActionError('E_CONFLICT', `工单已经结束：${input.ticketId}`)
  writeSpoolCommand(paths, {
    command: 'stop',
    ticketId: input.ticketId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  })
  return { ticketId: input.ticketId }
}

/** @throws ActionError E_NOT_FOUND：项目或被取代的记忆不存在 */
export function rememberRule(
  paths: Paths,
  memory: MemoryStore,
  input: { text: string; project?: string; supersedes?: string },
): { id: string } {
  if (input.project && !loadProjects(paths.projects).some((item) => item.id === input.project)) {
    throw new ActionError('E_NOT_FOUND', `没有登记这个项目：${input.project}`)
  }
  if (input.supersedes && !memory.get(input.supersedes)) {
    throw new ActionError('E_NOT_FOUND', `没有这条记忆：${input.supersedes}`)
  }
  const id = `remember-${randomUUID()}`
  const scope = input.project ? projectScope(input.project) : GLOBAL_SCOPE
  memory.record({
    id,
    at: new Date().toISOString(),
    origin: 'human',
    scope,
    pinned: true,
    body: input.text,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  })
  return { id }
}

/** @throws ActionError E_NOT_FOUND：记忆不存在 */
export function forgetEntry(memory: MemoryStore, input: { id: string; reason?: string }): { id: string } {
  if (!memory.get(input.id)) throw new ActionError('E_NOT_FOUND', `没有这条记忆：${input.id}`)
  memory.forget(input.id, input.reason ?? DEFAULT_FORGET_REASON, new Date().toISOString())
  return { id: input.id }
}
