/** Where the resident layer keeps its state, and its named limits. */
import { homedir } from 'node:os'
import { join } from 'node:path'

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

const DEFAULT_LEADER_MODEL = 'claude-opus-5-5'
const DEFAULT_LEADER_EFFORT = 'medium'

export interface Paths {
  home: string
  db: string
  spool: string
  rejected: string
  projects: string
  reviews: string
  lock: string
  /** An empty directory, so a Leader call picks up no project's instructions. */
  leaderCwd: string
}

export function pathsFor(home = process.env.RESIDENT_HOME ?? join(homedir(), '.more-agent')): Paths {
  return {
    home,
    db: join(home, 'resident.sqlite'),
    spool: join(home, 'spool'),
    rejected: join(home, 'spool', 'rejected'),
    projects: join(home, 'projects.json'),
    reviews: join(home, 'reviews.jsonl'),
    lock: join(home, 'resident.lock'),
    leaderCwd: join(home, 'leader-cwd'),
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
    command: parseCommand(env.RESIDENT_LEADER_COMMAND),
  }
}

function parseCommand(value: string | undefined): readonly string[] {
  if (!value) return ['claude']
  const command: unknown = JSON.parse(value)
  if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) {
    throw new Error('RESIDENT_LEADER_COMMAND must be a non-empty JSON array of strings')
  }
  return command as string[]
}
