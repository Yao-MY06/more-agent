/** Composes upstream's Engine, Store, Effects and Passes with the local Policy, Leader, and shadow or manager execution. */
import { mkdirSync } from 'node:fs'
import { lock } from 'proper-lockfile'
import { Effects } from '../vendor/dsh-superagent/src/app/effects.ts'
import { Passes } from '../vendor/dsh-superagent/src/app/passes.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { Engine, key, type Ticket, UserError } from '../vendor/dsh-superagent/src/core/index.ts'
import { HealthBoard } from '../vendor/dsh-superagent/src/infra/health.ts'
import { monotonicClock } from './clock.ts'
import {
  LOCK_RETRIES,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  type ManagerSettings,
  managerSettings,
  type Paths,
  RUN_POLL_MS,
  THREAD_WINDOW_MESSAGES,
  UNTIL_IDLE_LIMIT_MS,
} from './config.ts'
import { TicketExecutor } from './executor.ts'
import { appendInbox } from './inbox.ts'
import { LeaderAssessor, type LeaderHost } from './leader/assessor.ts'
import { buildContext, memoryCard } from './leader/context.ts'
import { LeaderReporter } from './leader/reporter.ts'
import type { Llm } from './llm/llm.ts'
import { ManagerExecutor } from './manager/executor.ts'
import { GLOBAL_SCOPE, MemoryRecorder, messageMemoryId, projectScope } from './memory/recorder.ts'
import { readRef } from './memory/refs.ts'
import { MemoryStore } from './memory/store.ts'
import { LocalOutbox } from './outbox.ts'
import { localPolicy, localScope } from './policy.ts'
import { loadProjects, type Project } from './projects.ts'
import { ShadowSteps } from './shadow.ts'
import { drainSpool, spoolFiles, toTrigger } from './spool.ts'
import { projectOfTicket, ticketExecutes } from './ticket-project.ts'

/** Deeper than the card, or a recall by the same words would find what the Leader already saw. */
const RECALL_SEARCH_LIMIT = 20
const MANAGER_RULES = 20
const MANAGER_MATCHES = 5

export interface RuntimeOptions {
  paths: Paths
  llm: Llm
  /** Another process took the lock over, so this one must stop writing. */
  onLockLost: (error: Error) => void
  manager?: ManagerSettings
  /** A problem in the background that no request is waiting on, such as a broken manager setup. */
  onError?: (error: unknown) => void
  /** False for measuring what memory is worth. Writing goes on either way; only reading stops. */
  memoryEnabled?: boolean
}

export class Runtime {
  readonly store: Store
  readonly engine: Engine
  private readonly paths: Paths
  private readonly effects: Effects
  private readonly passes: Passes
  private readonly manager: ManagerExecutor
  private readonly memory: MemoryStore
  private readonly recorder: MemoryRecorder
  private readonly memoryEnabled: boolean
  private readonly lifetime = new AbortController()
  private readonly onError: RuntimeOptions['onError']
  private closing = false
  private lastError?: string

  private constructor(options: RuntimeOptions) {
    this.paths = options.paths
    this.store = new Store(options.paths.db)
    const board = new HealthBoard()
    this.effects = new Effects(this.store, board)
    this.onError = options.onError
    this.memory = new MemoryStore(options.paths.memory)
    this.recorder = new MemoryRecorder({ effects: this.effects, memory: this.memory })
    this.memoryEnabled = options.memoryEnabled ?? process.env.RESIDENT_MEMORY !== 'off'
    const projects = () => loadProjects(options.paths.projects)
    const executes = (ticketId: string) =>
      ticketExecutes(ticketId, this.store.tickets, this.store.decisions, projects())
    const outbox = this.createOutbox(executes)
    const leader = {
      engine: () => this.engine,
      effects: this.effects,
      store: this.store,
      outbox,
      llm: options.llm,
      lifetime: this.lifetime.signal,
    }
    const assessor = this.createAssessor(leader, projects)
    this.manager = this.createManager(options, projects, outbox, new LeaderReporter(leader))
    const shadow = new ShadowSteps(leader)
    const executor = new TicketExecutor({
      effects: this.effects,
      // A Ticket already running stays with its manager even if the project's switch is turned off meanwhile.
      route: (ticketId) => (this.manager.owns(ticketId) || executes(ticketId) ? this.manager : shadow),
    })
    this.engine = new Engine({
      repo: this.store,
      scope: localScope,
      policy: localPolicy,
      assessor,
      executor,
      outbox,
      now: monotonicClock(),
      emit: (event) => {
        if (event.type === 'trigger.received') this.recordFollowup(event.data.triggerId)
      },
    })
    this.passes = new Passes({
      engine: this.engine,
      effects: this.effects,
      health: board.claim('runtime', { state: 'ready', detail: '' }),
      lifetime: this.lifetime.signal,
      configured: () => true,
      closing: () => this.closing,
    })
  }

  private createAssessor(
    leader: Pick<LeaderHost, 'engine' | 'effects' | 'store' | 'outbox' | 'llm' | 'lifetime'>,
    projects: () => Project[],
  ): LeaderAssessor {
    const contextHost = { store: this.store, memory: this.memory, enabled: this.memoryEnabled }
    return new LeaderAssessor({
      ...leader,
      projects,
      recorder: this.recorder,
      history: (candidate) => this.store.read.threadTriggers(candidate.thread.key, THREAD_WINDOW_MESSAGES),
      context: (candidate, recalled, allowed) => buildContext(contextHost, candidate, recalled, allowed),
      recall: (query, refs) => this.recall(query, refs),
    })
  }

  /** Only a message that reached a Ticket: any other waits for the Leader, whose judgement says where it belongs. */
  private recordFollowup(triggerId: string): void {
    const trigger = this.store.triggers.get(triggerId)
    const ticketId = this.store.triggers.disposition(triggerId)?.fanout[0]
    if (!trigger || !ticketId) return
    this.recorder.message(trigger, this.scopeOfTicket(ticketId), { ticketId })
  }

  private scopeOfTicket(ticketId: string): string {
    const ticket = this.store.tickets.get(ticketId)
    const project = ticket && projectOfTicket(ticket, this.store.decisions, loadProjects(this.paths.projects))
    return project ? projectScope(project.id) : GLOBAL_SCOPE
  }

  private recall(query: string | null, refs: readonly string[]): object[] {
    if (!this.memoryEnabled) return []
    const host = { store: this.store, memory: this.memory }
    const found = query ? this.memory.search(query, { limit: RECALL_SEARCH_LIMIT }).map(memoryCard) : []
    return [...found, ...refs.map((ref) => readRef(host, ref))]
  }

  /** The rules of this project and everywhere; other projects' records never reach it. */
  private managerMemories(ticket: Ticket, projectId: string, searched: boolean): object[] {
    if (!this.memoryEnabled) return []
    const scopes = [GLOBAL_SCOPE, projectScope(projectId)]
    const inForce = this.memory.pinned(scopes)
    const rules = inForce.slice(0, MANAGER_RULES)
    const shown = new Set([...rules.map((rule) => rule.id), ...ticket.origin.triggerIds.map(messageMemoryId)])
    const text = ticket.origin.triggerIds.map((id) => this.store.triggers.get(id)?.text ?? '').join('\n')
    const matches = searched ? this.memory.search(text, { scopes, limit: MANAGER_MATCHES + shown.size }) : []
    const cards = [...rules, ...matches.filter((hit) => !shown.has(hit.id)).slice(0, MANAGER_MATCHES)].map(memoryCard)
    const omitted = inForce.length - rules.length
    return omitted ? [...cards, { rules_not_shown: omitted }] : cards
  }

  private createOutbox(executes: (ticketId: string) => boolean): LocalOutbox {
    return new LocalOutbox({
      store: this.store,
      effects: this.effects,
      paths: this.paths,
      // A message outside any Ticket, such as the Leader's own question, always goes; a Ticket's follows its project.
      shouldSend: ({ ticketId }) => ticketId === undefined || executes(ticketId),
    })
  }

  private createManager(
    options: RuntimeOptions,
    projects: () => Project[],
    outbox: LocalOutbox,
    reporter: LeaderReporter,
  ): ManagerExecutor {
    return new ManagerExecutor({
      engine: () => this.engine,
      store: this.store,
      settings: options.manager ?? managerSettings(),
      paths: options.paths,
      projects,
      relay: (request) => {
        reporter.request(request)
        const ticket = this.store.tickets.get(request.ticketId)
        if (ticket) this.recorder.report(ticket, this.scopeOfTicket(ticket.id), request)
      },
      memories: (ticket, projectId, searched) => this.managerMemories(ticket, projectId, searched),
      redeliver: (ticketId) => this.effects.enqueue('delivery', ticketId, { ticketId }),
      notice: (ticketId, text) => {
        const channel = this.store.tickets.get(ticketId)?.channels[0]
        if (channel) outbox.send({ id: key('notice', ticketId, text), channel, text, kind: 'notice', ticketId })
      },
    })
  }

  /** One runner per home: upstream's Store assumes it is the only writer. A crashed runner's lock turns stale, so this waits it out. */
  static async open(options: RuntimeOptions): Promise<{ runtime: Runtime; release: () => Promise<void> }> {
    const { paths } = options
    for (const directory of [paths.home, paths.spool, paths.leaderCwd]) mkdirSync(directory, { recursive: true })
    const release = await lock(paths.home, {
      lockfilePath: paths.lock,
      stale: LOCK_STALE_MS,
      retries: { retries: LOCK_RETRIES, minTimeout: LOCK_RETRY_MS, maxTimeout: LOCK_RETRY_MS },
      onCompromised: options.onLockLost,
    })
    const runtime = new Runtime(options)
    runtime.effects.start()
    return { runtime, release }
  }

  /** Takes in the spool, runs one pass, and looks at the manager turns. */
  tick(): void {
    drainSpool(
      this.paths,
      (item) => {
        this.passes.receive(toTrigger(item))
      },
      (command) => this.stopTicket(command.ticketId, command.reason),
    )
    this.passes.request()
    this.manager.poll().catch((error: unknown) => this.report(error))
  }

  /** A stop of a Ticket that is unknown or over needs telling, not retrying, or the command would block the spool forever. */
  private stopTicket(ticketId: string, reason?: string): void {
    try {
      this.engine.stopTicket(ticketId, reason)
    } catch (error) {
      if (!(error instanceof UserError)) throw error
      appendInbox(this.paths, {
        id: key('stop-refused', ticketId, new Date().toISOString()),
        at: new Date().toISOString(),
        thread: 'cli:system',
        kind: 'notice',
        text: `没能停止工单 ${ticketId}：${error.message}`,
      })
    }
  }

  /** The same error repeats on every tick, so only a change is worth saying. */
  private report(error: unknown): void {
    const text = String(error)
    if (text !== this.lastError) this.onError?.(error)
    this.lastError = text
  }

  /** Whether anything waits: an unread request, an Eval, an effect (even one backing off), or a manager turn or wait. */
  busy(): boolean {
    const effect = this.store.db.prepare('SELECT 1 FROM effect LIMIT 1').get()
    return (
      spoolFiles(this.paths).length > 0 ||
      this.store.threads.active().length > 0 ||
      !!effect ||
      this.manager.jobs().length > 0 ||
      this.manager.stoppingWorkers()
    )
  }

  async runUntil(stop: () => boolean): Promise<void> {
    while (!stop()) {
      this.tick()
      await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS))
    }
  }

  /** @throws when work is still waiting after the limit, which the Eval deadlines should have prevented. */
  async runUntilIdle(signal?: AbortSignal, limitMs = UNTIL_IDLE_LIMIT_MS): Promise<void> {
    const started = Date.now()
    this.tick()
    await this.runUntil(() => !this.busy() || !!signal?.aborted || Date.now() - started > limitMs)
    if (!signal?.aborted && this.busy()) throw new Error(`Work is still waiting after ${limitMs} ms`)
  }

  /**
   * Stops new work and cancels a Leader call in flight; an unfinished effect stays queued for the next start. A manager turn
   * keeps running on purpose: the next start collects it.
   */
  async close(): Promise<void> {
    this.closing = true
    this.lifetime.abort()
    await this.passes.stop()
    await this.effects.drain()
    await this.manager.drain()
    this.memory.close()
    this.store.close()
  }
}
