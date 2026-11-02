/** Stands in for execution while a project's switch is off: every Ticket completes on paper, and no worker is ever touched. */
import type { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { type Engine, liveTicket, runningAssignment } from '../vendor/dsh-superagent/src/core/index.ts'
import type { ExecutionSteps } from './executor.ts'

export const SHADOW_SUMMARY = 'Shadow run: nothing was executed.'

export interface ShadowHost {
  engine(): Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'report'>
  store: Pick<Store, 'tickets'>
}

export class ShadowSteps implements ExecutionSteps {
  private readonly host: ShadowHost
  constructor(host: ShadowHost) {
    this.host = host
  }

  launch(ticketId: string, assignmentId: string): void {
    this.host.engine().assignmentStarted(ticketId, assignmentId)
    this.deliver(ticketId)
  }

  /** Every step checks the stored Ticket, so a replay after a crash finds it finished and leaves it. */
  deliver(ticketId: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && liveTicket(ticket) && runningAssignment(ticket)
    if (!ticket || !assignment) return
    const engine = this.host.engine()
    const inputs = [...ticket.undelivered]
    engine.inputsDelivered(ticketId, assignment.id, inputs)
    engine.inputsRead(ticketId, inputs)
    engine.report(ticketId, { state: 'ready', summary: SHADOW_SUMMARY })
  }

  /** Nothing runs, so there is nothing to stop. */
  stop(): void {}
}
