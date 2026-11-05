/** Read-only conversation views: what a person sent, what is still queued, and what the Leader said back. */
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { storeReads } from '../vendor/dsh-superagent/src/app/store-read.ts'
import type { Decision, Trigger } from '../vendor/dsh-superagent/src/core/index.ts'
import { openReadOnly, type Paths } from './config.ts'
import { type InboxEntry, readInbox } from './inbox.ts'
import { outcomeOf } from './report.ts'
import { pendingSpoolItems, toTrigger } from './spool.ts'

const THREAD_PREVIEW_CHARS = 80

export interface ThreadRow {
  key: string
  lastAt: string
  preview: string
  messageCount: number
}

export type ConversationMessage =
  /** state：queued 还在队列里，received 等待判断，decided 已判断（此时有 outcome）。 */
  | { role: 'user'; id: string; at: string; text: string; state: 'queued' | 'received' | 'decided'; outcome?: string }
  | { role: 'leader'; id: string; at: string; text: string; kind: InboxEntry['kind']; ticketId?: string }

interface ThreadData {
  triggers: Trigger[]
  outcomes: Map<string, string>
}

function openDatabase(paths: Paths): DatabaseSync | undefined {
  return existsSync(paths.db) ? openReadOnly(paths.db) : undefined
}

function threadRows(paths: Paths, limit: number): ThreadRow[] {
  const db = openDatabase(paths)
  if (!db) return []
  try {
    const rows = db
      .prepare(`
        SELECT x.thread AS thread, MAX(x.at) AS lastAt, COUNT(*) AS messageCount,
          (SELECT json_extract(t.value, '$.text') FROM trigger_thread latest
             JOIN trigger t ON t.id = latest.id
            WHERE latest.thread = x.thread
            ORDER BY latest.at DESC, latest.id DESC LIMIT 1) AS preview
          FROM trigger_thread x
         GROUP BY x.thread
         ORDER BY lastAt DESC
         LIMIT ?`)
      .all(limit)
    return rows.map((row) => ({
      key: String(row.thread),
      lastAt: String(row.lastAt),
      preview: String(row.preview ?? '').slice(0, THREAD_PREVIEW_CHARS),
      messageCount: Number(row.messageCount),
    }))
  } finally {
    db.close()
  }
}

function queuedThreads(paths: Paths): ThreadRow[] {
  const rows = new Map<string, ThreadRow>()
  for (const item of pendingSpoolItems(paths)) {
    const key = `${item.source}:${item.thread}`
    const current = rows.get(key)
    if (!current) {
      rows.set(key, { key, lastAt: item.at, preview: item.text.slice(0, THREAD_PREVIEW_CHARS), messageCount: 1 })
      continue
    }
    current.messageCount++
    if (item.at > current.lastAt) {
      current.lastAt = item.at
      current.preview = item.text.slice(0, THREAD_PREVIEW_CHARS)
    }
  }
  return [...rows.values()]
}

export function listThreads(paths: Paths, limit: number): ThreadRow[] {
  const rows = new Map(threadRows(paths, limit).map((row) => [row.key, row]))
  for (const row of queuedThreads(paths)) if (!rows.has(row.key)) rows.set(row.key, row)
  return [...rows.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit)
}

function decisionsFor(db: DatabaseSync, threadKey: string): Map<string, string> {
  const outcomes = new Map<string, string>()
  const rows = db.prepare('SELECT value FROM decision WHERE thread = ? ORDER BY rowid').all(threadKey)
  for (const row of rows) {
    const decision = JSON.parse(String(row.value)) as Decision
    for (const triggerId of decision.triggerIds) outcomes.set(triggerId, outcomeOf(decision))
  }
  return outcomes
}

function threadData(paths: Paths, threadKey: string, limit: number): ThreadData {
  const db = openDatabase(paths)
  if (!db) return { triggers: [], outcomes: new Map() }
  try {
    return {
      triggers: storeReads(db).threadTriggers(threadKey, limit),
      outcomes: decisionsFor(db, threadKey),
    }
  } finally {
    db.close()
  }
}

function receivedMessages(data: ThreadData): ConversationMessage[] {
  return data.triggers.map((trigger) => {
    const outcome = data.outcomes.get(trigger.id)
    return {
      role: 'user',
      id: trigger.id,
      at: trigger.at,
      text: trigger.text,
      state: outcome === undefined ? 'received' : 'decided',
      ...(outcome === undefined ? {} : { outcome }),
    }
  })
}

function queuedMessages(paths: Paths, threadKey: string): ConversationMessage[] {
  return pendingSpoolItems(paths).flatMap((item) => {
    if (`${item.source}:${item.thread}` !== threadKey) return []
    const trigger = toTrigger(item)
    return [{ role: 'user' as const, id: trigger.id, at: trigger.at, text: trigger.text, state: 'queued' as const }]
  })
}

function leaderMessages(paths: Paths, threadKey: string): ConversationMessage[] {
  return readInbox(paths)
    .entries.filter((entry) => entry.thread === threadKey)
    .map((entry) => ({
      role: 'leader',
      id: entry.id,
      at: entry.at,
      text: entry.text,
      kind: entry.kind,
      ...(entry.ticketId === undefined ? {} : { ticketId: entry.ticketId }),
    }))
}

export function readThread(paths: Paths, threadKey: string, limit: number): ConversationMessage[] {
  const received = receivedMessages(threadData(paths, threadKey, limit))
  const byId = new Map<string, ConversationMessage>()
  for (const message of [...queuedMessages(paths, threadKey), ...received, ...leaderMessages(paths, threadKey)]) {
    if (message.role === 'user') byId.set(message.id, message)
    else byId.set(`leader:${message.id}`, message)
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-limit)
}
