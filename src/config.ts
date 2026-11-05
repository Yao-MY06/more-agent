/** Where the resident layer keeps its state, and its named limits. */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Upstream's Eval window limits: enough to route on, small enough that one card stays cheap. */
export const TRIGGER_CHARS = 4000
export const THREAD_MESSAGE_CHARS = 400
export const THREAD_WINDOW_MESSAGES = 5
export const BRIEF_CHARS = 1500
export const MAX_TEXT_CHARS = 20_000

/** The Eval deadline must outlast one Leader call, or a slow call would expire its own Eval. */
export const LEADER_CALL_TIMEOUT_MS = 180_000
export const EVAL_TIMEOUT_MS = 300_000
export const LEADER_CONCURRENCY = 4
export const LEADER_RETRY_MS: readonly [number, number] = [5_000, 60_000]

export const RUN_POLL_MS = 500
export const UNTIL_IDLE_LIMIT_MS = 30 * 60_000

/** A crashed runner's lock turns stale after this long, which is how long a restart may have to wait. */
export const LOCK_STALE_MS = 10_000
export const LOCK_RETRIES = 30
export const LOCK_RETRY_MS = 1_000

/** A runaway guard: a manager has no reason to need more turns than this for one Ticket. */
export const MANAGER_MAX_TURNS = 30
export const MANAGER_TURN_TIMEOUT_MS = 60 * 60_000
export const MANAGER_TICKET_BUDGET_USD = 15
export const MAX_RUNNING_MANAGERS = 1
export const OMH_POLL_MS = 5_000
/** A killed turn is gone within the supervisor's next tick and its force-kill delay. */
export const TURN_STOP_WAIT_MS = 15_000
export const TURN_STOP_POLL_MS = 200
export const OMH_CALL_TIMEOUT_MS = 20_000
/** Longer than any worker's own hard timeout, so this only catches `omh` itself being broken. */
export const WORKER_WAIT_LIMIT_MS = 6 * 60 * 60_000
export const SUMMARY_CHARS = 4000
/** If the Leader stays unavailable this long, the person gets the manager's own words rather than silence. */
export const RELAY_GIVE_UP_MS = 5 * 60_000

const DEFAULT_LEADER_MODEL = 'claude-opus-5-5'
const DEFAULT_LEADER_EFFORT = 'medium'
const DEFAULT_MANAGER_MODEL = 'claude-opus-5-5'
const DEFAULT_MANAGER_EFFORT = 'medium'
const DEFAULT_MANAGER_TURN_BUDGET_USD = 3
const SUPERVISOR_SCRIPT = 'scripts/turn-supervisor.mjs'
const DEFAULT_OMH = '../opus-manager/harness/bin/omh.js'
const DEFAULT_SKILL = '../opus-manager/skill/zh/opus-manager/SKILL.md'

/** The project root, whether this code runs from source or from `lib/`. */
export function projectRoot(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let directory = from
  while (!existsSync(join(directory, SUPERVISOR_SCRIPT))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot find ${SUPERVISOR_SCRIPT}`)
    directory = parent
  }
  return directory
}

export function supervisorPath(): string {
  return join(projectRoot(), SUPERVISOR_SCRIPT)
}

export interface Paths {
  home: string
  db: string
  spool: string
  rejected: string
  projects: string
  reviews: string
  inbox: string
  inboxRead: string
  lock: string
  /** An empty directory, so a Leader call picks up no project's instructions. */
  leaderCwd: string
  jobs: string
  /** One Markdown file per day, the only place memory lives. */
  memory: string
}

export function pathsFor(home = process.env.RESIDENT_HOME ?? join(homedir(), '.more-agent')): Paths {
  return {
    home,
    db: join(home, 'resident.sqlite'),
    spool: join(home, 'spool'),
    rejected: join(home, 'spool', 'rejected'),
    projects: join(home, 'projects.json'),
    reviews: join(home, 'reviews.jsonl'),
    inbox: join(home, 'inbox.jsonl'),
    inboxRead: join(home, 'inbox.read'),
    lock: join(home, 'resident.lock'),
    leaderCwd: join(home, 'leader-cwd'),
    jobs: join(home, 'jobs'),
    memory: join(home, 'memory'),
  }
}

export interface LeaderSettings {
  model: string
  effort: string
  /** The command that stands in for `claude`, as a JSON array, such as a fixture in tests. */
  command: readonly string[]
}

export function leaderSettings(env: NodeJS.ProcessEnv = process.env): LeaderSettings {
  return {
    model: env.RESIDENT_LEADER_MODEL ?? DEFAULT_LEADER_MODEL,
    effort: env.RESIDENT_LEADER_EFFORT ?? DEFAULT_LEADER_EFFORT,
    command: parseCommand(env.RESIDENT_LEADER_COMMAND, 'RESIDENT_LEADER_COMMAND'),
  }
}

function parseCommand(value: string | undefined, name: string): readonly string[] {
  if (!value) return ['claude']
  const command: unknown = JSON.parse(value)
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
    throw new Error(`${name} must be a non-empty JSON array of strings`)
  }
  return command as string[]
}

export interface ManagerSettings {
  model: string
  effort: string
  command: readonly string[]
  /** List-price limit for one turn, passed to the CLI. */
  turnBudgetUsd: number
  /** `omh.js`, which the manager reaches through MCP and the runner polls. */
  omh: string
  /** opus-manager's skill file, whose ticket workflow becomes the manager's instructions. */
  skill: string
}

export function managerSettings(env: NodeJS.ProcessEnv = process.env): ManagerSettings {
  const root = projectRoot()
  return {
    model: env.RESIDENT_MANAGER_MODEL ?? DEFAULT_MANAGER_MODEL,
    effort: env.RESIDENT_MANAGER_EFFORT ?? DEFAULT_MANAGER_EFFORT,
    command: parseCommand(env.RESIDENT_MANAGER_COMMAND, 'RESIDENT_MANAGER_COMMAND'),
    turnBudgetUsd: Number(env.RESIDENT_MANAGER_TURN_BUDGET_USD ?? DEFAULT_MANAGER_TURN_BUDGET_USD),
    omh: resolve(root, env.RESIDENT_OMH ?? DEFAULT_OMH),
    skill: resolve(root, env.RESIDENT_MANAGER_SKILL ?? DEFAULT_SKILL),
  }
}
