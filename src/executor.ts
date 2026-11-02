/** The Engine's Executor port: launches and deliveries go through the durable effect queue, then to shadow or real execution. */
import type { Effects } from '../vendor/dsh-superagent/src/app/effects.ts'
import type { Assignment, Executor, Ticket } from '../vendor/dsh-superagent/src/core/index.ts'

export interface ExecutionSteps {
  launch(ticketId: string, assignmentId: string): void
  deliver(ticketId: string): void
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}

export interface TicketExecutorHost {
  effects: Pick<Effects, 'enqueue' | 'handle'>
  /** Which way this Ticket runs. */
  route(ticketId: string): ExecutionSteps
}

export class TicketExecutor implements Executor {
  private readonly host: TicketExecutorHost
  constructor(host: TicketExecutorHost) {
    this.host = host
    host.effects.handle('launch', async ({ ticketId, assignmentId }) => {
      host.route(ticketId).launch(ticketId, assignmentId)
    })
    host.effects.handle('delivery', async ({ ticketId }) => {
      host.route(ticketId).deliver(ticketId)
    })
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  deliver(ticket: Ticket): void {
    this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }

  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.host.route(ticket.id).stop(ticket, assignment, reason)
  }
}
