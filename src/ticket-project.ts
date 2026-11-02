/** Which project a Ticket belongs to: the one the Leader named in the Decision that accepted it. */
import type { Decision, Ticket } from '../vendor/dsh-superagent/src/core/index.ts'
import type { Project } from './projects.ts'

export function projectOfTicket(
  ticket: Pick<Ticket, 'decisionId'>,
  decisions: { get(id: string): Decision | undefined },
  projects: readonly Project[],
): Project | undefined {
  const audit = decisions.get(ticket.decisionId)?.audit as { project?: string | null } | undefined
  return projects.find((project) => project.id === audit?.project)
}

/** A Ticket of a project the person has not switched on, or that is gone, stays in shadow. */
export function ticketExecutes(
  ticketId: string | undefined,
  tickets: { get(id: string): Ticket | undefined },
  decisions: { get(id: string): Decision | undefined },
  projects: readonly Project[],
): boolean {
  const ticket = ticketId === undefined ? undefined : tickets.get(ticketId)
  return !!ticket && !!projectOfTicket(ticket, decisions, projects)?.execute
}
