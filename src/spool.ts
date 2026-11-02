/**
 * Requests waiting for the runner, one file each. Only the runner opens the database for writing, as upstream's Store
 * requires, so a command in another process hands over a file instead, and that works while no runner is up.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Trigger } from '../vendor/dsh-superagent/src/core/index.ts'
import { MAX_TEXT_CHARS, type Paths } from './config.ts'

export const LOCAL_SOURCES = ['cli', 'replay'] as const
export const LOCAL_USER = 'owner'
const SPOOL_SUFFIX = '.json'
const TIME_DIGITS = 15
const COUNTER_DIGITS = 6
const EXPECTED_CHARS = 80

export const SpoolItemSchema = z
  .object({
    id: z.string().regex(/^[\w.-]{1,120}$/),
    source: z.enum(LOCAL_SOURCES),
    thread: z.string().regex(/^[\w.-]{1,120}$/),
    text: z.string().trim().min(1).max(MAX_TEXT_CHARS),
    at: z.iso.datetime(),
    expected: z.string().min(1).max(EXPECTED_CHARS).optional(),
  })
  .strict()
export type SpoolItem = z.infer<typeof SpoolItemSchema>

const SpoolCommandSchema = z
  .object({
    command: z.literal('stop'),
    ticketId: z.string().min(1),
    reason: z.string().max(MAX_TEXT_CHARS).optional(),
  })
  .strict()
export type SpoolCommand = z.infer<typeof SpoolCommandSchema>

let written = 0

/** Hands over one request; the rename makes it visible whole, and the counter keeps a thread's messages in order. */
export function writeSpool(paths: Paths, item: SpoolItem): void {
  writeEntry(paths, SpoolItemSchema.parse(item))
}

/** Hands over a person's command, in order with their messages: only the runner may change a Ticket. */
export function writeSpoolCommand(paths: Paths, command: SpoolCommand): void {
  writeEntry(paths, SpoolCommandSchema.parse(command))
}

function writeEntry(paths: Paths, valid: SpoolItem | SpoolCommand): void {
  mkdirSync(paths.spool, { recursive: true })
  const time = String(Date.now()).padStart(TIME_DIGITS, '0')
  const counter = String(++written).padStart(COUNTER_DIGITS, '0')
  const name = `${time}-${counter}-${randomUUID()}`
  const temporary = join(paths.spool, `${name}.tmp`)
  writeFileSync(temporary, JSON.stringify(valid))
  renameSync(temporary, join(paths.spool, `${name}${SPOOL_SUFFIX}`))
}

export function spoolFiles(paths: Paths): string[] {
  mkdirSync(paths.spool, { recursive: true })
  return readdirSync(paths.spool)
    .filter((name) => name.endsWith(SPOOL_SUFFIX))
    .sort()
}

/**
 * Takes in every waiting request, oldest first. A file goes only after `receive` returned: a crash in between delivers it
 * again, and the Engine stores a Trigger id once. A file that does not parse moves aside instead of blocking the rest.
 */
export function drainSpool(
  paths: Paths,
  receive: (item: SpoolItem) => void,
  command: (command: SpoolCommand) => void = () => {},
): number {
  let taken = 0
  for (const name of spoolFiles(paths)) {
    const file = join(paths.spool, name)
    const entry = parseEntry(file)
    if (!entry) {
      moveAside(paths, name)
      continue
    }
    if ('command' in entry) command(entry)
    else receive(entry)
    unlinkSync(file)
    taken++
  }
  return taken
}

function parseEntry(file: string): SpoolItem | SpoolCommand | undefined {
  try {
    return z.union([SpoolItemSchema, SpoolCommandSchema]).parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

function moveAside(paths: Paths, name: string): void {
  mkdirSync(paths.rejected, { recursive: true })
  renameSync(join(paths.spool, name), join(paths.rejected, name))
}

export function toTrigger(item: SpoolItem): Trigger {
  const thread = { source: item.source, id: item.thread }
  return {
    id: `${item.source}:${item.id}`,
    source: item.source,
    threads: [thread],
    actor: { source: item.source, id: LOCAL_USER },
    human: true,
    addressed: 'direct',
    at: item.at,
    text: item.text,
    channel: { source: item.source, thread: `${item.source}:${item.thread}`, address: {} },
    meta: item.expected ? { expected: item.expected } : {},
  }
}
