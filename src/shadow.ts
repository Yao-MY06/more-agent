/** Stands in for execution and sending in M0: every Ticket completes on paper, and no worker or channel is ever touched. */
import type { Effects } from '../vendor/dsh-superagent/src/app/effects.ts'
import type { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import {
  type Assignment,
  type Engine,
  type Executor,
  liveTicket,
  type OutboundMessage,
  type Outbox,
  type ReplyStatus,
  runningAssignment,
  type Ticket,
} from '../vendor/dsh-superagent/src/core/index.ts'

export const SHADOW_SUMMARY = 'Shadow run: nothing was executed.'

type ShadowEngine = Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'report'>

export interface ShadowHost {
  engine(): ShadowEngine
  effects: Pick<Effects, 'enqueue' | 'handle'>
  store: Pick<Store, 'tickets'>
}

export class ShadowExecutor implements Executor {
  private readonly host: ShadowHost
  constructor(host: ShadowHost) {
    this.host = host
    host.effects.handle('launch', async ({ ticketId, assignmentId }) => {
      this.launch(ticketId, assignmentId)
    })
    host.effects.handle('delivery', async ({ ticketId }) => {
      this.settle(ticketId)
    })
  }

  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  deliver(ticket: Ticket): void {
    this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }

  /** Nothing runs, so there is nothing to stop. */
  stop(): void {}

  private launch(ticketId: string, assignmentId: string): void {
    this.host.engine().assignmentStarted(ticketId, assignmentId)
    this.settle(ticketId)
  }

  /** Every step checks the stored Ticket, so a replay after a crash finds it finished and leaves it. */
  private settle(ticketId: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && liveTicket(ticket) && runningAssignment(ticket)
    if (!ticket || !assignment) return
    const engine = this.host.engine()
    const inputs = [...ticket.undelivered]
    engine.inputsDelivered(ticketId, assignment.id, inputs)
    engine.inputsRead(ticketId, inputs)
    engine.report(ticketId, { state: 'ready', summary: SHADOW_SUMMARY })
  }
}

/** Keeps what would have been said as pending receipts; no effect ever sends them. */
export class ShadowOutbox implements Outbox {
  private readonly store: Pick<Store, 'receipts' | 'replyStatus'>
  constructor(store: Pick<Store, 'receipts' | 'replyStatus'>) {
    this.store = store
  }

  send(message: OutboundMessage): void {
    this.store.receipts.add(message)
  }

  status(id: string): ReplyStatus | undefined {
    return this.store.replyStatus(id)
  }

  withdraw(id: string): void {
    this.store.receipts.withdraw(id)
  }
}
