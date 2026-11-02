/** The manager's `claude` command line: what it may touch is decided here, not in its prompt. */
import { createHash } from 'node:crypto'
import type { ManagerSettings } from '../config.ts'

/** No Bash: a manager writes tickets and uses `omh`, so a request's text can never become a shell command through it. */
const BUILT_IN_TOOLS = 'Read,Glob,Grep,Edit,Write'
/** `omh_wait` is left out on purpose: a manager ends its turn and is woken, so waiting costs no quota. */
const OMH_TOOLS = ['status', 'next', 'new', 'dispatch', 'review', 'verify', 'packet', 'move', 'log', 'setup']
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit(_tickets/**)',
  'Write(_tickets/**)',
  ...OMH_TOOLS.map((tool) => `mcp__omh__omh_${tool}`),
].join(',')

const UUID_PARTS: readonly [number, number][] = [
  [0, 8],
  [8, 12],
  [12, 16],
  [16, 20],
  [20, 32],
]

/** Derived from the Ticket, so a restart can never start a second session for the same work. */
export function sessionIdFor(ticketId: string): string {
  const hex = createHash('sha256').update(ticketId).digest('hex')
  const parts = UUID_PARTS.map(([from, to]) => hex.slice(from, to))
  return `${parts[0]}-${parts[1]}-4${parts[2]?.slice(1)}-a${parts[3]?.slice(1)}-${parts[4]}`
}

export interface ManagerTurnOptions {
  sessionId: string
  /** Whether a session was already started for this Ticket. */
  resume: boolean
  systemPromptFile: string
  schema: object
}

export function managerArguments(settings: ManagerSettings, options: ManagerTurnOptions): string[] {
  const mcp = { mcpServers: { omh: { command: process.execPath, args: [settings.omh, 'mcp'] } } }
  return [
    '-p',
    '--model',
    settings.model,
    '--effort',
    settings.effort,
    '--permission-mode',
    'dontAsk',
    '--tools',
    BUILT_IN_TOOLS,
    '--allowedTools',
    ALLOWED_TOOLS,
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcp),
    '--setting-sources',
    'project,local',
    '--disable-slash-commands',
    '--max-budget-usd',
    String(settings.turnBudgetUsd),
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(options.schema),
    '--append-system-prompt-file',
    options.systemPromptFile,
    options.resume ? '--resume' : '--session-id',
    options.sessionId,
  ]
}
