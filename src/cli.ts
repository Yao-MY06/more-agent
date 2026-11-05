/** The `resident` command. Commands that change state hand it to the runner or to plain files; only `run` opens the database for writing. */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { ActionError, forgetEntry, rememberRule, submitMessage, submitStop } from './actions.ts'
import { leaderSettings, MAX_TEXT_CHARS, type Paths, pathsFor } from './config.ts'
import { readInbox, takeUnread } from './inbox.ts'
import { ClaudeCli } from './llm/claude-cli.ts'
import { GLOBAL_SCOPE, projectScope } from './memory/recorder.ts'
import { type MemoryEntry, MemoryStore } from './memory/store.ts'
import { addProject, loadProjects } from './projects.ts'
import { appendReview, decisionRows, readStatus, readSummary, renderReport, triggerExists } from './report.ts'
import { Runtime } from './runtime.ts'
import { spoolFiles, writeSpool } from './spool.ts'
import { readTickets, renderTicket, resolveTicketId } from './tickets-view.ts'
import { DEFAULT_PORT, startWebServer } from './web/server.ts'

const TICKET_ID_CHARS = 12
const MEMORY_PREVIEW_CHARS = 120
const MEMORY_SEARCH_LIMIT = 20

const USAGE = `用法：resident <命令>

  project add <id> <路径> [--brief 文本] [--execute]
                                           登记项目（默认取其 README 开头作简介；不加 --execute 只做影子运行）
  project list                             列出项目
  say <文本> [--thread 话题]               提交一条请求，或在某个话题上继续说
  inbox [--all] [--json]                   查看 Leader 发给你的新消息
  remember <文本> [--project 项目] [--supersedes 记忆 id]
                                           记下一条规则，之后的工作都会带上
  memory list|search <词>|show <id>|forget <id> [--project 项目] [--reason 原因] [--json]
                                           查看或作废记忆
  tickets [--json]                         查看工单
  stop <工单 id 前缀> [--reason 原因]      停止工单，连同它的经理和工人
  replay <文件.jsonl>                      回放历史请求，每行 {id, text, thread?, expected?}
  web [--port 端口]                        启动只监听本机的网页面板
  run [--until-idle]                       运行
  status [--json]                          查看状态
  decisions                                以 JSON 列出全部决策
  report [--json]                          决策报告
  review <触发器 id> ok|wrong [--note 备注] 人工核对一条决策

环境变量：RESIDENT_HOME、RESIDENT_LEADER_MODEL、RESIDENT_LEADER_EFFORT、RESIDENT_MEMORY`

const ReplayLineSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1).max(MAX_TEXT_CHARS),
    thread: z.string().optional(),
    expected: z.string().optional(),
  })
  .strict()

export interface Io {
  out(line: string): void
  err(line: string): void
}

type Command = (args: string[], paths: Paths, io: Io) => number | Promise<number>

const usageError = (io: Io): number => {
  io.err(USAGE)
  return 1
}

/** Keeps the CLI's words and exit code while sharing the action that the panel calls. */
function runCliAction(io: Io, run: () => number): number {
  try {
    return run()
  } catch (error) {
    if (!(error instanceof ActionError)) throw error
    io.err(error.message)
    return 1
  }
}

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

function project(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({
    args,
    options: { brief: { type: 'string' }, execute: { type: 'boolean' } },
    allowPositionals: true,
  })
  const [action, id, path] = positionals
  if (action === 'list') {
    for (const item of loadProjects(paths.projects)) {
      io.out(`${item.id}\t${item.execute ? '执行' : '影子'}\t${item.path}`)
    }
    return 0
  }
  if (action !== 'add' || !id || !path) return usageError(io)
  const added = addProject(paths.projects, {
    id,
    path,
    execute: !!values.execute,
    ...(values.brief === undefined ? {} : { brief: values.brief }),
  })
  io.out(`已登记 ${added.id}（简介 ${added.brief.length} 字，${added.execute ? '会真实执行' : '只做影子运行'}）`)
  return 0
}

function inbox(args: string[], paths: Paths, io: Io): number {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' }, json: { type: 'boolean' } } })
  const entries = values.all ? readInbox(paths).entries : takeUnread(paths)
  if (values.json) {
    io.out(JSON.stringify(entries))
    return 0
  }
  if (!entries.length) io.out('没有新消息')
  for (const entry of entries) io.out(`${entry.at} [${entry.thread.replace(/^[^:]*:/, '')}] ${entry.text}`)
  return 0
}

function say(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({ args, options: { thread: { type: 'string' } }, allowPositionals: true })
  const text = positionals.join(' ')
  if (!text) return usageError(io)
  const input = { text, ...(values.thread === undefined ? {} : { thread: values.thread }) }
  io.out(submitMessage(paths, input).triggerId)
  return 0
}

/** Every line is checked before any is handed over, so a bad file replays nothing rather than half. */
function replay(args: string[], paths: Paths, io: Io): number {
  const [file] = args
  if (!file) return usageError(io)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const items = lines.map((line) => ReplayLineSchema.parse(JSON.parse(line)))
  const base = Date.now()
  items.forEach((item, index) => {
    writeSpool(paths, {
      id: item.id,
      source: 'replay',
      thread: item.thread ?? item.id,
      text: item.text,
      at: new Date(base + index).toISOString(),
      ...(item.expected ? { expected: item.expected } : {}),
    })
  })
  io.out(`已提交 ${items.length} 条回放请求`)
  return 0
}

const MAX_PORT = 65_535

function parseWebPort(args: string[], io: Io): number | undefined {
  try {
    const { values } = parseArgs({ args, options: { port: { type: 'string' } } })
    const raw = values.port ?? String(DEFAULT_PORT)
    if (!/^\d+$/.test(raw) || Number(raw) > MAX_PORT) throw new Error('invalid port')
    return Number(raw)
  } catch {
    io.err('端口必须是 0 到 65535 之间的整数')
    return undefined
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolve()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
}

async function web(args: string[], paths: Paths, io: Io): Promise<number> {
  const port = parseWebPort(args, io)
  if (port === undefined) return 1
  let server: Awaited<ReturnType<typeof startWebServer>>
  try {
    server = await startWebServer({ paths, port })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    io.err(`端口 ${port} 已被占用，请用 --port 换一个端口`)
    return 1
  }
  io.out(`网页面板：${server.url}`)
  io.out('这个链接等于操作权限，不要发给别人。按 Ctrl+C 停止。')
  try {
    await waitForShutdown()
    return 0
  } finally {
    await server.close()
  }
}

async function run(args: string[], paths: Paths, io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { 'until-idle': { type: 'boolean' } } })
  const llm = new ClaudeCli(leaderSettings(), paths.leaderCwd)
  const onLockLost = (error: Error) => {
    io.err(`运行锁丢失，退出：${error.message}`)
    process.exit(1)
  }
  const onError = (error: unknown) => io.err(`后台出错：${String(error)}`)
  const { runtime, release } = await Runtime.open({ paths, llm, onLockLost, onError })
  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort())
  try {
    if (values['until-idle']) await runtime.runUntilIdle(stop.signal)
    else await runtime.runUntil(() => stop.signal.aborted)
    return 0
  } finally {
    await runtime.close()
    await release()
  }
}

function status(args: string[], paths: Paths, io: Io): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } })
  const current = readStatus(paths, spoolFiles(paths).length)
  io.out(
    values.json
      ? toJson(current)
      : `待接收 ${current.spoolWaiting}，请求 ${current.triggers}，评估中话题 ${current.activeThreads}，待办效果 ${current.effects}，工单 ${current.tickets}，本来会发 ${current.wouldSay}，已发 ${current.sent}`,
  )
  return 0
}

function tickets(args: string[], paths: Paths, io: Io): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } })
  const rows = readTickets(paths)
  if (values.json) io.out(toJson(rows))
  else if (!rows.length) io.out('还没有工单')
  else for (const row of rows) io.out(renderTicket(row))
  return 0
}

function stop(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({ args, options: { reason: { type: 'string' } }, allowPositionals: true })
  const [prefix] = positionals
  if (!prefix) return usageError(io)
  const ticketId = resolveTicketId(paths, prefix)
  if (!ticketId) {
    io.err(`没有唯一匹配的工单：${prefix}`)
    return 1
  }
  return runCliAction(io, () => {
    const input = { ticketId, ...(values.reason === undefined ? {} : { reason: values.reason }) }
    submitStop(paths, input)
    io.out(`已提交停止 ${ticketId.slice(0, TICKET_ID_CHARS)}，runner 处理后会连同工人一起停下`)
    return 0
  })
}

function remember(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({
    args,
    options: { project: { type: 'string' }, supersedes: { type: 'string' } },
    allowPositionals: true,
  })
  const text = positionals.join(' ')
  if (!text) return usageError(io)
  const memory = new MemoryStore(paths.memory)
  try {
    return runCliAction(io, () => {
      const input = {
        text,
        ...(values.project === undefined ? {} : { project: values.project }),
        ...(values.supersedes === undefined ? {} : { supersedes: values.supersedes }),
      }
      io.out(rememberRule(paths, memory, input).id)
      return 0
    })
  } finally {
    memory.close()
  }
}

function renderMemory(entry: MemoryEntry): string {
  const pinned = entry.pinned ? ' 规则' : ''
  return `${entry.id}  ${entry.at}  ${entry.scope}  ${entry.origin}${pinned}\n    ${entry.body.replace(/\s+/g, ' ').slice(0, MEMORY_PREVIEW_CHARS)}`
}

function printMemories(entries: readonly MemoryEntry[], json: boolean | undefined, io: Io): number {
  if (json) io.out(toJson(entries))
  else if (!entries.length) io.out('没有记录')
  else for (const entry of entries) io.out(renderMemory(entry))
  return 0
}

function memoryCommand(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({
    args,
    options: { project: { type: 'string' }, reason: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
  })
  const [action, ...rest] = positionals
  const memory = new MemoryStore(paths.memory)
  const scopes = values.project ? [GLOBAL_SCOPE, projectScope(values.project)] : undefined
  try {
    if (action === 'list') return printMemories(memory.list(), values.json, io)
    if (action === 'search' && rest.length) {
      const options = { limit: MEMORY_SEARCH_LIMIT, ...(scopes ? { scopes } : {}) }
      return printMemories(memory.search(rest.join(' '), options), values.json, io)
    }
    const [id] = rest
    if (!id) return usageError(io)
    if (action === 'show') return showMemory(memory, id, io)
    if (action === 'forget') return forgetMemory(memory, id, values.reason, io)
    return usageError(io)
  } finally {
    memory.close()
  }
}

function showMemory(memory: MemoryStore, id: string, io: Io): number {
  const entry = memory.get(id)
  if (!entry) {
    io.err(`没有这条记忆：${id}`)
    return 1
  }
  io.out(toJson(entry))
  return 0
}

function forgetMemory(memory: MemoryStore, id: string, reason: string | undefined, io: Io): number {
  return runCliAction(io, () => {
    const input = { id, ...(reason === undefined ? {} : { reason }) }
    forgetEntry(memory, input)
    io.out(`已作废 ${id}，原文仍留在记忆文件里`)
    return 0
  })
}

function decisions(_args: string[], paths: Paths, io: Io): number {
  io.out(toJson(decisionRows(paths)))
  return 0
}

function report(args: string[], paths: Paths, io: Io): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } })
  const current = readSummary(paths)
  io.out(values.json ? toJson(current.summary) : renderReport(current))
  return 0
}

function review(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({ args, options: { note: { type: 'string' } }, allowPositionals: true })
  const [triggerId, verdict] = positionals
  if (!triggerId || (verdict !== 'ok' && verdict !== 'wrong')) return usageError(io)
  if (!triggerExists(paths, triggerId)) {
    io.err(`没有这条请求：${triggerId}`)
    return 1
  }
  const note = values.note === undefined ? {} : { note: values.note }
  appendReview(paths, { triggerId, verdict, ...note, at: new Date().toISOString() })
  io.out(`已记录 ${triggerId}：${verdict}`)
  return 0
}

const COMMANDS: Record<string, Command> = {
  project,
  inbox,
  say,
  remember,
  memory: memoryCommand,
  tickets,
  stop,
  replay,
  web,
  run,
  status,
  decisions,
  report,
  review,
}

/**
 * Runs one command.
 * @param argv the arguments after the program name
 * @param io where output goes
 * @param paths the state to work on
 * @returns the process exit code: 0 on success, 1 on bad usage
 * @throws on invalid input files or state, which the entry point reports
 */
export async function main(argv: string[], io: Io, paths: Paths = pathsFor()): Promise<number> {
  const [name, ...args] = argv
  const command = name ? COMMANDS[name] : undefined
  return command ? command(args, paths, io) : usageError(io)
}
