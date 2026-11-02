/**
 * What the Leader says to the person, as a plain file: the local Channel. The runner appends and readers dedupe by id, so a
 * crash between appending and settling the receipt shows a message once, not twice.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { Paths } from './config.ts'

const InboxEntrySchema = z
  .object({
    id: z.string().min(1),
    at: z.string(),
    thread: z.string(),
    kind: z.enum(['acknowledgement', 'reply', 'notice']),
    text: z.string(),
    ticketId: z.string().optional(),
  })
  .strict()
export type InboxEntry = z.infer<typeof InboxEntrySchema>

/** The leading newline keeps this message whole even if an earlier write was cut off mid-line. */
export function appendInbox(paths: Paths, entry: InboxEntry): void {
  mkdirSync(dirname(paths.inbox), { recursive: true })
  appendFileSync(paths.inbox, `\n${JSON.stringify(InboxEntrySchema.parse(entry))}\n`)
}

function parseLine(line: string): InboxEntry | undefined {
  try {
    return InboxEntrySchema.parse(JSON.parse(line))
  } catch {
    return undefined
  }
}

/** Oldest first, each id once. `skipped` counts lines that do not parse, such as a write a crash cut off. */
export function readInbox(paths: Paths): { entries: InboxEntry[]; skipped: number } {
  if (!existsSync(paths.inbox)) return { entries: [], skipped: 0 }
  const lines = readFileSync(paths.inbox, 'utf8').split('\n').filter(Boolean)
  const parsed = lines.map(parseLine)
  const unique = new Map<string, InboxEntry>()
  for (const entry of parsed) if (entry && !unique.has(entry.id)) unique.set(entry.id, entry)
  return { entries: [...unique.values()], skipped: parsed.filter((entry) => !entry).length }
}

function readCount(paths: Paths): number {
  return existsSync(paths.inboxRead) ? Number(readFileSync(paths.inboxRead, 'utf8')) || 0 : 0
}

/** The messages not returned before, which counts as reading them. */
export function takeUnread(paths: Paths): InboxEntry[] {
  const { entries } = readInbox(paths)
  const unread = entries.slice(readCount(paths))
  if (!unread.length) return []
  const temporary = `${paths.inboxRead}.tmp`
  writeFileSync(temporary, String(entries.length))
  renameSync(temporary, paths.inboxRead)
  return unread
}
