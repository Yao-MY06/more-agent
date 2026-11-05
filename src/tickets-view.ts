/** A read-only view of the Tickets, for a person checking on work. It never needs the runner's lock. */
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { type Decision, type Ticket, ticketStage } from '../vendor/dsh-superagent/src/core/index.ts'
import { openReadOnly, type Paths } from './config.ts'
import { MANAGER_TICKET, type ManagerTicketState } from './manager/executor.ts'

const STAGE_WORDS: Record<string, string> = { ended: '已结束', person: '等你', working: '进行中', idle: '等工人' }
const ID_CHARS = 12
const TITLE_CHARS = 40
const MAX_TICKETS = 200

export interface TicketRow {
  id: string
  title: string
  project?: string
  stage: string
  outcome?: string
  question?: string
  turns: number
  costUsd: number
}

function kv<T>(db: DatabaseSync, name: string): T | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(name)
  return row ? (JSON.parse(String(row.value)) as T) : undefined
}

function toRow(db: DatabaseSync, ticket: Ticket): TicketRow {
  const row = db.prepare('SELECT value FROM decision WHERE id = ?').get(ticket.decisionId)
  const decision = row ? (JSON.parse(String(row.value)) as Decision) : undefined
  const project = (decision?.audit as { project?: string } | undefined)?.project
  const state = kv<ManagerTicketState>(db, MANAGER_TICKET(ticket.id))
  return {
    id: ticket.id,
    title: ticket.title,
    stage: ticketStage(ticket).stage,
    turns: state?.turns ?? 0,
    costUsd: state?.costUsd ?? 0,
    ...(project ? { project } : {}),
    ...(ticket.ended ? { outcome: ticket.ended.outcome } : {}),
    ...(ticket.attention ? { question: ticket.attention.question } : {}),
  }
}

/** Newest first. */
export function readTickets(paths: Paths): TicketRow[] {
  if (!existsSync(paths.db)) return []
  const db = openReadOnly(paths.db)
  try {
    return db
      .prepare('SELECT value FROM ticket ORDER BY rowid DESC LIMIT ?')
      .all(MAX_TICKETS)
      .map((row) => toRow(db, JSON.parse(String(row.value)) as Ticket))
  } finally {
    db.close()
  }
}

export function renderTicket(row: TicketRow): string {
  const stage = STAGE_WORDS[row.stage] ?? row.stage
  const outcome = row.outcome ? `（${row.outcome}）` : ''
  const question = row.question ? `\n    问题：${row.question}` : ''
  const cost = `${row.turns} 轮，经理牌价 $${row.costUsd.toFixed(2)}`
  return `${row.id.slice(0, ID_CHARS)}  ${stage}${outcome}  ${row.project ?? '-'}  ${row.title.slice(0, TITLE_CHARS)}  ${cost}${question}`
}

/** @returns the one Ticket id starting with `prefix`, or undefined when none or several match. */
export function resolveTicketId(paths: Paths, prefix: string): string | undefined {
  const matches = readTickets(paths).filter((row) => row.id.startsWith(prefix))
  return matches.length === 1 ? matches[0]?.id : undefined
}
