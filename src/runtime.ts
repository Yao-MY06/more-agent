/** Composes upstream's Engine, Store, Effects and Passes with the local Policy, Leader and shadow execution. */
import { mkdirSync } from 'node:fs'
import { lock } from 'proper-lockfile'
import { Effects } from '../vendor/dsh-superagent/src/app/effects.ts'
import { Passes } from '../vendor/dsh-superagent/src/app/passes.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { Engine } from '../vendor/dsh-superagent/src/core/index.ts'
import { HealthBoard } from '../vendor/dsh-superagent/src/infra/health.ts'
import { monotonicClock } from './clock.ts'
import {
  LOCK_RETRIES,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  type Paths,
  RUN_POLL_MS,
  THREAD_WINDOW_MESSAGES,
  UNTIL_IDLE_LIMIT_MS,
} from './config.ts'
import { LeaderAssessor } from './leader/assessor.ts'
import type { Llm } from './llm/llm.ts'
import { localPolicy, localScope } from './policy.ts'
import { loadProjects } from './projects.ts'
import { ShadowExecutor, ShadowOutbox } from './shadow.ts'
import { drainSpool, spoolFiles, toTrigger } from './spool.ts'

export interface RuntimeOptions {
  paths: Paths
  llm: Llm
  /** Another process took the lock over, so this one must stop writing. */
  onLockLost: (error: Error) => void
}

export class Runtime {
  readonly store: Store
  readonly engine: Engine
  private readonly paths: Paths
  private readonly effects: Effects
  private readonly passes: Passes
  private readonly lifetime = new AbortController()
  private closing = false

  private constructor(options: RuntimeOptions) {
    this.paths = options.paths
    this.store = new Store(options.paths.db)
    const board = new HealthBoard()
    this.effects = new Effects(this.store, board)
    const host = { engine: () => this.engine, effects: this.effects }
    const assessor = new LeaderAssessor({
      ...host,
      llm: options.llm,
      projects: () => loadProjects(options.paths.projects),
      history: (candidate) => this.store.read.threadTriggers(candidate.thread.key, THREAD_WINDOW_MESSAGES),
      lifetime: this.lifetime.signal,
    })
    const executor = new ShadowExecutor({ ...host, store: this.store })
    this.engine = new Engine({
      repo: this.store,
      scope: localScope,
      policy: localPolicy,
      assessor,
      executor,
      outbox: new ShadowOutbox(this.store),
      now: monotonicClock(),
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

  /** Takes in the spool and runs one pass. */
  tick(): void {
    drainSpool(this.paths, (item) => {
      this.passes.receive(toTrigger(item))
    })
    this.passes.request()
  }

  /** Whether anything waits: an unread request, an Eval, or an effect, including one backing off before a retry. */
  busy(): boolean {
    const effect = this.store.db.prepare('SELECT 1 FROM effect LIMIT 1').get()
    return spoolFiles(this.paths).length > 0 || this.store.threads.active().length > 0 || !!effect
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

  /** Stops new work and cancels a Leader call in flight; an unfinished effect stays queued for the next start. */
  async close(): Promise<void> {
    this.closing = true
    this.lifetime.abort()
    await this.passes.stop()
    await this.effects.drain()
    this.store.close()
  }
}
