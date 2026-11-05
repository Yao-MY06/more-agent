/**
 * Runs a Ticket as turns of one manager session. A turn is a detached process; between turns nothing runs and nothing is
 * spent. Every step is recorded with the Engine's state in one transaction, so a crash can neither lose a report nor apply it
 * twice, and a restart finds each turn where it left it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Later } from '../../vendor/dsh-superagent/src/app/effects.ts'
import type { Store } from '../../vendor/dsh-superagent/src/app/store.ts'
import {
  type Assignment,
  type Engine,
  liveTicket,
  runningAssignment,
  type Ticket,
} from '../../vendor/dsh-superagent/src/core/index.ts'
import { family } from '../../vendor/dsh-superagent/src/kv.ts'
import {
  MANAGER_MAX_TURNS,
  MANAGER_TICKET_BUDGET_USD,
  MANAGER_TURN_TIMEOUT_MS,
  MAX_RUNNING_MANAGERS,
  type ManagerSettings,
  OMH_POLL_MS,
  type Paths,
  TURN_STOP_POLL_MS,
  TURN_STOP_WAIT_MS,
  WORKER_WAIT_LIMIT_MS,
} from '../config.ts'
import type { ExecutionSteps } from '../executor.ts'
import { resolveInvocation } from '../llm/resolve-command.ts'
import type { Project } from '../projects.ts'
import { projectOfTicket } from '../ticket-project.ts'
import { managerArguments, sessionIdFor } from './args.ts'
import { killWorkers, runningTickets } from './omh.ts'
import { loadManagerSkill, managerSystemPrompt, type TurnReason, turnCard } from './prompt.ts'
import { type ManagerReport, managerReportJsonSchema, parseTurnOutcome } from './report.ts'
import { killTurn, readTurn, startTurn, type TurnView } from './turn.ts'

/** What runs for a Ticket right now. No record means nothing does. */
export interface ManagerJob {
  ticketId: string
  assignmentId: string
  projectId: string
  phase: 'turn' | 'waiting'
  directory: string
  inputIds: string[]
  waitFor: string[]
  waitingSince?: string
}

export interface ManagerTicketState {
  turns: number
  sessionStarted: boolean
  /** What this Ticket's managers have cost, list price. */
  costUsd: number
  /** The total the current session last reported. */
  sessionTotalUsd: number
}

export const MANAGER_JOB = family<ManagerJob>('manager-job:')
export const MANAGER_TICKET = family<ManagerTicketState>('manager-ticket:')

export interface RelayRequest {
  ticketId: string
  state: string
  summary: string
  question?: string
}

export interface ManagerHost {
  engine(): Pick<
    Engine,
    | 'assignmentStarted'
    | 'inputsDelivered'
    | 'inputsRead'
    | 'turnEnded'
    | 'report'
    | 'assignmentInterrupted'
    | 'reply'
    | 'handback'
  >
  store: Pick<
    Store,
    'atomic' | 'afterCommit' | 'get' | 'set' | 'delete' | 'keys' | 'tickets' | 'triggers' | 'decisions'
  >
  settings: ManagerSettings
  paths: Paths
  projects(): Project[]
  /** Queues a report for the Leader to pass on to the person, inside the caller's transaction. */
  relay(request: RelayRequest): void
  /** Queues another delivery of the Ticket's waiting Inputs. */
  redeliver(ticketId: string): void
  /** Records for this project's manager; `searched` adds what matches the request, on top of the rules that always apply. */
  memories(ticket: Ticket, projectId: string, searched: boolean): object[]
  /** Tells the person something went wrong outside any turn. */
  notice(ticketId: string, text: string): void
}

const failureQuestion = (reason: string): string => `经理这一轮没有完成：${reason}。回复这条消息就会让它接着做。`

async function untilTurnEnds(directory: string): Promise<void> {
  const deadline = Date.now() + TURN_STOP_WAIT_MS
  while (readTurn(directory).phase === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TURN_STOP_POLL_MS))
  }
}

export class ManagerExecutor implements ExecutionSteps {
  private readonly host: ManagerHost
  private readonly lastChecked = new Map<string, number>()
  private polling?: Promise<void>
  private readonly stopping = new Set<Promise<void>>()
  constructor(host: ManagerHost) {
    this.host = host
  }

  jobs(): ManagerJob[] {
    const { store } = this.host
    return store.keys(MANAGER_JOB).flatMap((name) => store.get(name) ?? [])
  }

  /** Whether something of this Ticket is running or waited on right now. */
  owns(ticketId: string): boolean {
    return !!this.job(ticketId)
  }

  private job(ticketId: string): ManagerJob | undefined {
    return this.host.store.get(MANAGER_JOB(ticketId))
  }

  private state(ticketId: string): ManagerTicketState {
    return (
      this.host.store.get(MANAGER_TICKET(ticketId)) ?? {
        turns: 0,
        sessionStarted: false,
        costUsd: 0,
        sessionTotalUsd: 0,
      }
    )
  }

  /** What stops a Ticket from running at all, in words for the person; these need a person, so retrying would not help. */
  private problemOf(ticket: Ticket): string | undefined {
    const { settings, store, projects } = this.host
    const project = projectOfTicket(ticket, store.decisions, projects())
    if (!project?.execute) return '项目没有开启执行'
    if (!existsSync(project.path)) return `项目目录不存在：${project.path}`
    if (!existsSync(join(project.path, '.omh', 'config.json'))) {
      return `项目 ${project.id} 还没有配置 omh。请在项目里运行 omh init，并决定工人和同意项`
    }
    if (!existsSync(settings.omh)) return `找不到 omh：${settings.omh}`
    if (!existsSync(settings.skill)) return `找不到 opus-manager 技能文件：${settings.skill}`
    if (!resolveInvocation(settings.command[0] ?? '', [])) return `找不到命令：${settings.command[0]}`
    return undefined
  }

  /** One project runs one Ticket at a time: `omh` workers of two Tickets would share a working tree and a stop could not tell them apart. */
  private assertRoom(ticket: Ticket): void {
    const { store, projects } = this.host
    const project = projectOfTicket(ticket, store.decisions, projects())
    const others = this.jobs().filter((job) => job.ticketId !== ticket.id)
    if (others.filter((job) => job.phase === 'turn').length >= MAX_RUNNING_MANAGERS)
      throw new Later('No manager slot is free')
    if (others.some((job) => job.projectId === project?.id)) throw new Later('The project is running another Ticket')
  }

  launch(ticketId: string, assignmentId: string): void {
    const { store } = this.host
    const ticket = store.tickets.get(ticketId)
    const assignment = ticket?.assignments.find((item) => item.id === assignmentId)
    if (!ticket || !assignment || !liveTicket(ticket) || assignment.state === 'ended') return
    // A restart can replay this effect after the turn it started: that turn is already recorded.
    if (this.job(ticketId)?.assignmentId === assignmentId) return
    const problem = this.problemOf(ticket)
    if (problem) {
      store.atomic(() => {
        this.host.engine().assignmentStarted(ticketId, assignmentId)
        this.fail(ticketId, problem)
      })
      return
    }
    this.assertRoom(ticket)
    this.host.engine().assignmentStarted(ticketId, assignmentId)
    this.beginTurn(ticketId, { kind: 'assignment' })
  }

  /** Waiting Inputs go into the next turn: one that is running cannot take them, so they wait for it to end. */
  deliver(ticketId: string): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || !runningAssignment(ticket) || !ticket.undelivered.length) return
    if (this.job(ticketId)?.phase === 'turn') return
    this.assertRoom(ticket)
    this.beginTurn(ticketId, { kind: 'inputs' })
  }

  /** The Engine calls this inside a transaction, so the kill waits for the commit. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const { store } = this.host
    const job = this.job(ticket.id)
    if (job?.assignmentId !== assignment.id) return
    store.delete(MANAGER_JOB(ticket.id))
    store.afterCommit(() => {
      killTurn(job.directory)
      this.stopWorkers(job, reason)
    })
  }

  private stopWorkers(job: ManagerJob, reason: string): void {
    const { host } = this
    const stopping: Promise<void> = this.endWorkers(job, reason)
      .catch((error: unknown) => host.notice(job.ticketId, `停止工单时查不到工人状态（${reason}）：${String(error)}`))
      .finally(() => this.stopping.delete(stopping))
    this.stopping.add(stopping)
  }

  private async endWorkers(job: ManagerJob, reason: string): Promise<void> {
    const { host } = this
    const project = host.projects().find((item) => item.id === job.projectId)
    if (!project) return
    // A turn still going could dispatch one more worker, which a look at what runs now would miss.
    await untilTurnEnds(job.directory)
    const failed = await killWorkers(host.settings.omh, project.path, `resident 停止了这张工单：${reason}`)
    if (failed.length) host.notice(job.ticketId, `停止工单时有工人没能处理好（${reason}）：${failed.join('；')}`)
  }

  /** Whether workers of a stopped Ticket are still being ended, which the runner must not exit or close the database during. */
  stoppingWorkers(): boolean {
    return this.stopping.size > 0
  }

  /** Waits for what is in flight, so the database can close under nothing. */
  async drain(): Promise<void> {
    await Promise.allSettled([this.polling, ...this.stopping])
  }

  /** Records the turn first and starts it after the commit: a crash in between leaves a record of a dead turn, which recovery handles. */
  private beginTurn(ticketId: string, reason: TurnReason): void {
    const { store, paths, settings } = this.host
    const ticket = store.tickets.get(ticketId)
    const assignment = ticket && runningAssignment(ticket)
    if (!ticket || !assignment) return
    const project = projectOfTicket(ticket, store.decisions, this.host.projects())
    const state = this.state(ticketId)
    const overLimit = this.overLimit(state)
    if (overLimit || !project) {
      store.atomic(() => this.fail(ticketId, overLimit ?? '项目已不存在'))
      return
    }
    const directory = join(paths.jobs, ticketId, `turn-${state.turns + 1}`)
    const inputIds = [...ticket.undelivered]
    mkdirSync(directory, { recursive: true })
    const systemPromptFile = join(directory, 'system-prompt.md')
    writeFileSync(systemPromptFile, managerSystemPrompt(loadManagerSkill(settings.skill)))
    const args = managerArguments(settings, {
      sessionId: sessionIdFor(ticketId),
      resume: state.sessionStarted,
      systemPromptFile,
      schema: managerReportJsonSchema(),
    })
    const [command, ...prefix] = settings.command
    const invocation = resolveInvocation(command ?? '', [...prefix, ...args])
    if (!invocation) throw new Error(`Command not found: ${command}`)
    const memories = this.host.memories(ticket, project.id, reason.kind === 'assignment')
    const stdin = turnCard(ticket, reason, inputIds, (id) => store.triggers.get(id), memories)
    store.atomic(() => {
      store.set(MANAGER_TICKET(ticketId), { ...state, turns: state.turns + 1, sessionStarted: true })
      store.set(MANAGER_JOB(ticketId), {
        ticketId,
        assignmentId: assignment.id,
        projectId: project.id,
        phase: 'turn',
        directory,
        inputIds,
        waitFor: [],
      })
      if (inputIds.length) this.host.engine().inputsDelivered(ticketId, assignment.id, inputIds)
      store.afterCommit(() =>
        startTurn(directory, { ...invocation, cwd: project.path, stdin, timeoutMs: MANAGER_TURN_TIMEOUT_MS }),
      )
    })
  }

  private overLimit(state: ManagerTicketState): string | undefined {
    if (state.turns >= MANAGER_MAX_TURNS) return `这张单已经跑了 ${state.turns} 轮，超过上限`
    if (state.costUsd >= MANAGER_TICKET_BUDGET_USD)
      return `这张单的经理已花掉牌价 $${state.costUsd.toFixed(2)}，超过上限`
    return undefined
  }

  /** The Ticket waits for the person; their reply starts the next turn. */
  private fail(ticketId: string, reason: string): void {
    this.host.store.delete(MANAGER_JOB(ticketId))
    const question = failureQuestion(reason)
    this.host.engine().report(ticketId, { state: 'failed', summary: reason, question })
    this.host.relay({ ticketId, state: 'failed', summary: reason, question })
  }

  /** Called on every runner tick. Never overlaps itself, and the runner waits for it before closing the database. */
  poll(): Promise<void> {
    this.polling ??= this.pollJobs().finally(() => {
      this.polling = undefined
    })
    return this.polling
  }

  private async pollJobs(): Promise<void> {
    for (const job of this.jobs()) {
      if (job.phase === 'turn') this.pollTurn(job)
      else await this.pollWaiting(job)
    }
  }

  private pollTurn(job: ManagerJob): void {
    const view = readTurn(job.directory)
    if (view.phase === 'finished') this.collect(job, view)
    else if (view.phase === 'dead') this.recover(job)
  }

  /** The dead turn may have got partway, so the next one is told to look before acting. */
  private recover(job: ManagerJob): void {
    const { store, engine } = this.host
    store.atomic(() => {
      store.delete(MANAGER_JOB(job.ticketId))
      engine().assignmentInterrupted(job.ticketId, job.assignmentId)
    })
    const ticket = store.tickets.get(job.ticketId)
    // The Engine leaves a settled Assignment as it is and starts nothing, but this turn was still owed its work.
    if (ticket && liveTicket(ticket) && runningAssignment(ticket)?.id === job.assignmentId) {
      this.beginTurn(job.ticketId, { kind: 'interrupted' })
    }
  }

  private collect(job: ManagerJob, view: TurnView): void {
    const { store, engine } = this.host
    const outcome = parseTurnOutcome(view)
    if (outcome.kind === 'session-lost') {
      store.set(MANAGER_TICKET(job.ticketId), {
        ...this.state(job.ticketId),
        sessionStarted: false,
        sessionTotalUsd: 0,
      })
      this.recover(job)
      return
    }
    store.atomic(() => {
      store.delete(MANAGER_JOB(job.ticketId))
      if (outcome.kind === 'killed') return
      if (outcome.sessionTotalUsd !== undefined) this.addCost(job.ticketId, outcome.sessionTotalUsd)
      const ticket = store.tickets.get(job.ticketId)
      if (!ticket || !liveTicket(ticket)) return
      engine().inputsRead(job.ticketId, job.inputIds)
      engine().turnEnded(job.ticketId, job.assignmentId)
      if (outcome.kind === 'failure') this.fail(job.ticketId, outcome.reason)
      else this.applyReport(job, outcome.report)
    })
  }

  /** The CLI reports a resumed session's running total, so this turn cost only what the total grew by. */
  private addCost(ticketId: string, sessionTotalUsd: number): void {
    const state = this.state(ticketId)
    const spent = sessionTotalUsd >= state.sessionTotalUsd ? sessionTotalUsd - state.sessionTotalUsd : sessionTotalUsd
    this.host.store.set(MANAGER_TICKET(ticketId), { ...state, costUsd: state.costUsd + spent, sessionTotalUsd })
  }

  private applyFollowups(job: ManagerJob, report: ManagerReport): void {
    const { engine, store } = this.host
    const reached = new Set(
      store.tickets
        .get(job.ticketId)
        ?.inputs.filter((input) => job.inputIds.includes(input.id))
        .flatMap((input) => (input.kind === 'trigger' ? [input.triggerId] : [])),
    )
    for (const followup of report.followups) {
      // A manager can only speak to messages this turn showed it; any other id is a mistake, not an instruction.
      if (!reached.has(followup.trigger_id)) continue
      if (followup.decision === 'hand_back') engine().handback(job.ticketId, followup.trigger_id, followup.text)
      else {
        engine().reply({
          purpose: 'acknowledgement',
          ticketId: job.ticketId,
          triggerId: followup.trigger_id,
          text: followup.text,
        })
      }
    }
  }

  private applyReport(job: ManagerJob, report: ManagerReport): void {
    const { engine, store } = this.host
    const { ticketId } = job
    this.applyFollowups(job, report)
    const waiting = !!store.tickets.get(ticketId)?.undelivered.length
    if (report.state === 'waiting') {
      engine().report(ticketId, { state: 'waiting', summary: report.summary, question: null })
      store.set(MANAGER_JOB(ticketId), {
        ...job,
        phase: 'waiting',
        inputIds: [],
        waitFor: report.wait_for,
        waitingSince: new Date().toISOString(),
      })
    } else if (report.state === 'blocked') {
      const question = report.question ?? undefined
      engine().report(ticketId, { state: 'blocked', summary: report.summary, ...(question ? { question } : {}) })
      this.host.relay({ ticketId, state: 'blocked', summary: report.summary, ...(question ? { question } : {}) })
    } else if (waiting) {
      // Messages arrived during this turn, which never saw them: it cannot be finished until they have had a turn.
      engine().report(ticketId, { state: 'progress', summary: report.summary, question: null })
    } else {
      this.host.relay({ ticketId, state: report.state, summary: report.summary })
      engine().report(ticketId, { state: report.state, summary: report.summary, question: null })
    }
    if (waiting) this.host.redeliver(ticketId)
  }

  private async pollWaiting(job: ManagerJob): Promise<void> {
    const { settings, projects } = this.host
    const now = Date.now()
    if (now - (this.lastChecked.get(job.ticketId) ?? 0) < OMH_POLL_MS) return
    this.lastChecked.set(job.ticketId, now)
    const project = projects().find((item) => item.id === job.projectId)
    let running: string[] | undefined
    try {
      running = project && (await runningTickets(settings.omh, project.path))
    } catch {
      // `omh` being briefly unreadable is not a reason to wake a manager; the limit below catches it staying broken.
      running = undefined
    }
    // Other things may have changed this Ticket while the call ran.
    const current = this.job(job.ticketId)
    if (current?.phase !== 'waiting' || current.assignmentId !== job.assignmentId) return
    if (running && !current.waitFor.some((ticket) => running.includes(ticket))) {
      this.beginTurn(job.ticketId, { kind: 'workers-finished', tickets: current.waitFor })
      return
    }
    if (Date.parse(current.waitingSince ?? '') + WORKER_WAIT_LIMIT_MS < now) {
      this.host.store.atomic(() => this.fail(job.ticketId, `等工人 ${current.waitFor.join('、')} 超过了时限`))
    }
  }
}
