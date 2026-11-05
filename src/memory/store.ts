/**
 * The memory log: one Markdown file per day, which a person can read and edit, and which is the only thing that holds memory.
 * The search index is built from those files in memory, so it can never disagree with them or need migrating.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { diversify } from './diversify.ts'
import { ftsQuery, memoryTokens } from './tokens.ts'

export const MEMORY_BODY_LIMIT_CHARS = 20_000
const DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/
const DATE_CHARS = 10
const OPEN_PREFIX = '<!-- memory '
const OPEN_SUFFIX = ' -->'
const CLOSE = '<!-- /memory -->'
/** A line of a body that a parser could mistake for structure gets this in front, so a message can never forge an entry. */
const ESCAPE = '\\'
const NEEDS_ESCAPE = /^\\*<!-- \/?memory/
const DEFAULT_LIMIT = 5
const DEFAULT_LIST_LIMIT = 50
/** A wide net for the ranking below to narrow, since BM25 alone knows nothing of age. */
const CANDIDATES = 200
const HALF_LIFE_DAYS = 30
const DAY_MS = 24 * 60 * 60_000

const HeaderSchema = z
  .object({
    id: z.string().min(1),
    at: z.iso.datetime(),
    origin: z.enum(['human', 'agent']),
    scope: z.string().regex(/^(global|project:[a-z0-9-]+)$/),
    pinned: z.boolean().optional(),
    refs: z.array(z.string()).optional(),
    supersedes: z.string().optional(),
    /** Marks an entry that exists only to retire another: it says why, and is not itself something to recall. */
    retires: z.boolean().optional(),
  })
  .strict()

const InputSchema = HeaderSchema.extend({ body: z.string().trim().min(1).max(MEMORY_BODY_LIMIT_CHARS) })
export type MemoryInput = z.infer<typeof InputSchema>
export type MemoryEntry = MemoryInput & { supersededBy?: string }
export type MemoryHit = MemoryEntry & { score: number }

export interface SearchOptions {
  /** Only these scopes; every scope when left out. */
  scopes?: readonly string[]
  limit?: number
  now?: number
}

function format({ body, ...header }: MemoryInput): string {
  const lines = body.split('\n').map((line) => (NEEDS_ESCAPE.test(line) ? `${ESCAPE}${line}` : line))
  return `\n${OPEN_PREFIX}${JSON.stringify(header)}${OPEN_SUFFIX}\n${lines.join('\n')}\n${CLOSE}\n`
}

function parseHeader(line: string): z.infer<typeof HeaderSchema> | undefined {
  try {
    return HeaderSchema.parse(JSON.parse(line.slice(OPEN_PREFIX.length, -OPEN_SUFFIX.length)))
  } catch {
    return undefined
  }
}

const unescapeLine = (line: string): string => (NEEDS_ESCAPE.test(line) ? line.slice(ESCAPE.length) : line)

function parseFile(text: string): { entries: MemoryInput[]; skipped: number } {
  const entries: MemoryInput[] = []
  let skipped = 0
  let open: { header?: z.infer<typeof HeaderSchema>; body: string[] } | undefined
  for (const line of text.split(/\r?\n/)) {
    if (!open) {
      if (line.startsWith(OPEN_PREFIX)) open = { header: parseHeader(line), body: [] }
      continue
    }
    if (line !== CLOSE) {
      open.body.push(unescapeLine(line))
      continue
    }
    const parsed = open.header && InputSchema.safeParse({ ...open.header, body: open.body.join('\n') })
    if (parsed?.success) entries.push(parsed.data)
    else skipped++
    open = undefined
  }
  return { entries, skipped }
}

/** Pinned entries do not fade: a person asked for them to last. */
function decay(entry: MemoryEntry, now: number): number {
  if (entry.pinned) return 1
  const days = Math.max(0, (now - Date.parse(entry.at)) / DAY_MS)
  return Math.exp(-(Math.LN2 / HALF_LIFE_DAYS) * days)
}

/**
 * FTS5 ranks better matches lower, so this only flips the sign. OpenClaw squeezes the rank into 0..1 because it adds vector scores;
 * with nothing to add, squeezing only made a match three times better look 10% better, and let age decide.
 */
const relevance = (rank: number): number => -rank

export class MemoryStore {
  private readonly directory: string
  private entries = new Map<string, MemoryEntry>()
  private db?: DatabaseSync
  private fingerprint?: string
  private skippedCount = 0

  constructor(directory: string) {
    this.directory = directory
  }

  private files(): string[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory)
      .filter((name) => DAILY_FILE.test(name))
      .sort()
  }

  private currentFingerprint(): string {
    return this.files()
      .map((name) => {
        const { mtimeMs, size } = statSync(join(this.directory, name))
        return `${name}:${mtimeMs}:${size}`
      })
      .join('|')
  }

  /** Rebuilds only when a file changed, which also picks up a person's hand edit. */
  private load(): DatabaseSync {
    const fingerprint = this.currentFingerprint()
    if (this.db && fingerprint === this.fingerprint) return this.db
    this.db?.close()
    const inputs = this.files().map((name) => parseFile(readFileSync(join(this.directory, name), 'utf8')))
    this.skippedCount = inputs.reduce((sum, file) => sum + file.skipped, 0)
    this.entries = new Map()
    for (const input of inputs.flatMap((file) => file.entries)) {
      if (!this.entries.has(input.id)) this.entries.set(input.id, input)
    }
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE VIRTUAL TABLE memory USING fts5(id UNINDEXED, tokens, tokenize='unicode61')")
    const insert = db.prepare('INSERT INTO memory (id, tokens) VALUES (?, ?)')
    db.exec('BEGIN')
    for (const entry of this.entries.values()) this.index(insert, entry)
    db.exec('COMMIT')
    this.db = db
    this.fingerprint = fingerprint
    return db
  }

  private index(insert: ReturnType<DatabaseSync['prepare']>, entry: MemoryEntry): void {
    const replaced = entry.supersedes ? this.entries.get(entry.supersedes) : undefined
    if (replaced) replaced.supersededBy = entry.id
    if (!entry.retires) insert.run(entry.id, memoryTokens(entry.body).join(' '))
  }

  /** Recording an id again changes nothing, so a replay after a crash is safe. @throws on an invalid entry. */
  record(input: MemoryInput): void {
    const entry = InputSchema.parse(input)
    const db = this.load()
    if (this.entries.has(entry.id)) return
    mkdirSync(this.directory, { recursive: true })
    appendFileSync(join(this.directory, `${entry.at.slice(0, DATE_CHARS)}.md`), format(entry))
    this.entries.set(entry.id, entry)
    this.index(db.prepare('INSERT INTO memory (id, tokens) VALUES (?, ?)'), entry)
    this.fingerprint = this.currentFingerprint()
  }

  /** Retires an entry without erasing it: the text stays on disk, and the reason beside it. @throws when it does not exist. */
  forget(id: string, reason: string, at: string): void {
    const target = this.get(id)
    if (!target) throw new Error(`No memory with id ${id}`)
    this.record({
      id: `forget-${id}`,
      at,
      origin: 'human',
      scope: target.scope,
      supersedes: id,
      retires: true,
      body: reason,
    })
  }

  /** Best first. What was replaced or retired does not come back here; it stays readable through `get`. */
  search(query: string, options: SearchOptions = {}): MemoryHit[] {
    const db = this.load()
    const match = ftsQuery(query)
    if (!match) return []
    const { scopes, limit = DEFAULT_LIMIT, now = Date.now() } = options
    const rows = db
      .prepare('SELECT id, bm25(memory) AS rank FROM memory WHERE memory MATCH ? ORDER BY rank LIMIT ?')
      .all(match, CANDIDATES)
    const hits = rows
      .flatMap((row): MemoryHit[] => {
        const entry = this.entries.get(String(row.id))
        if (!entry || entry.supersededBy || (scopes && !scopes.includes(entry.scope))) return []
        return [{ ...entry, score: relevance(Number(row.rank)) * decay(entry, now) }]
      })
      .sort((a, b) => b.score - a.score)
    return diversify(hits, limit)
  }

  /** What a person asked to remember and is still in force, newest first. */
  pinned(scopes?: readonly string[]): MemoryEntry[] {
    return this.current()
      .filter((entry) => entry.pinned && (!scopes || scopes.includes(entry.scope)))
      .slice(0, CANDIDATES)
  }

  private current(): MemoryEntry[] {
    this.load()
    return [...this.entries.values()]
      .filter((entry) => !entry.supersededBy && !entry.retires)
      .sort((a, b) => b.at.localeCompare(a.at))
  }

  get(id: string): MemoryEntry | undefined {
    this.load()
    return this.entries.get(id)
  }

  /** Newest first, leaving out what was replaced or retired. */
  list(limit = DEFAULT_LIST_LIMIT): MemoryEntry[] {
    return this.current().slice(0, limit)
  }

  /** Entries on disk that could not be read, for a person to look at. */
  skipped(): number {
    this.load()
    return this.skippedCount
  }

  close(): void {
    this.db?.close()
    this.db = undefined
    this.fingerprint = undefined
  }
}
