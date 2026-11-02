/**
 * Delivers the Engine's messages to the local inbox: a persistent receipt plus a retried `reply` effect, as upstream's
 * app/outbox.ts does for its Sources. Messages that may not go out, such as those of a shadow Ticket, stay as pending receipts.
 */
import type { Effects } from '../vendor/dsh-superagent/src/app/effects.ts'
import type { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import type { OutboundMessage, Outbox, ReplyStatus } from '../vendor/dsh-superagent/src/core/index.ts'
import type { Paths } from './config.ts'
import { appendInbox } from './inbox.ts'

const REPLY_RETRY_MS: readonly [number, number] = [2_000, 60_000]

export interface LocalOutboxHost {
  store: Pick<Store, 'atomic' | 'receipts' | 'replyStatus'>
  effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle'>
  paths: Paths
  shouldSend(message: OutboundMessage): boolean
}

export class LocalOutbox implements Outbox {
  private readonly host: LocalOutboxHost
  constructor(host: LocalOutboxHost) {
    this.host = host
    host.effects.handle('reply', async (_payload, id) => this.deliver(id), { ordered: true, retry: REPLY_RETRY_MS })
  }

  send(message: OutboundMessage): void {
    const { store, effects, shouldSend } = this.host
    store.atomic(() => {
      if (store.receipts.add(message) && shouldSend(message)) effects.enqueue('reply', message.id, {})
    })
  }

  status(id: string): ReplyStatus | undefined {
    return this.host.store.replyStatus(id)
  }

  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => {
      if (store.receipts.withdraw(id)) effects.cancel('reply', id)
    })
  }

  private deliver(id: string): void {
    const { store, paths } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    appendInbox(paths, {
      id,
      at: new Date().toISOString(),
      thread: receipt.channel.thread,
      kind: receipt.kind,
      text: receipt.text,
      ...(receipt.ticketId ? { ticketId: receipt.ticketId } : {}),
    })
    store.receipts.settle(receipt, 'sent')
  }
}
