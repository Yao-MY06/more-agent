/** The `resident` command. Commands that change state hand it to the runner or to plain files; only `run` opens the database for writing. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { leaderSettings, MAX_TEXT_CHARS, type Paths, pathsFor } from './config.ts'
import { ClaudeCli } from './llm/claude-cli.ts'
import { addProject, loadProjects } from './projects.ts'
import { appendReview, decisionRows, readStatus, readSummary, renderReport, triggerExists } from './report.ts'
import { Runtime } from './runtime.ts'
import { spoolFiles, writeSpool } from './spool.ts'

const USAGE = `用法：resident <命令>

  project add <id> <路径> [--brief 文本]   登记项目（默认取其 README 开头作简介）
  project list                             列出项目
  say <文本> [--thread 话题]               提交一条请求
  replay <文件.jsonl>                      回放历史请求，每行 {id, text, thread?, expected?}
  run [--until-idle]                       运行（M0 只记录判断，不执行任何工作）
  status [--json]                          查看状态
  decisions                                以 JSON 列出全部决策
  report [--json]                          决策报告
  review <触发器 id> ok|wrong [--note 备注] 人工核对一条决策

环境变量：RESIDENT_HOME、RESIDENT_LEADER_MODEL、RESIDENT_LEADER_EFFORT`

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

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

function project(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({ args, options: { brief: { type: 'string' } }, allowPositionals: true })
  const [action, id, path] = positionals
  if (action === 'list') {
    for (const item of loadProjects(paths.projects)) io.out(`${item.id}\t${item.path}`)
    return 0
  }
  if (action !== 'add' || !id || !path) return usageError(io)
  const added = addProject(paths.projects, { id, path, ...(values.brief === undefined ? {} : { brief: values.brief }) })
  io.out(`已登记 ${added.id}（简介 ${added.brief.length} 字）`)
  return 0
}

function say(args: string[], paths: Paths, io: Io): number {
  const { values, positionals } = parseArgs({ args, options: { thread: { type: 'string' } }, allowPositionals: true })
  const text = positionals.join(' ')
  if (!text) return usageError(io)
  const id = randomUUID()
  writeSpool(paths, { id, source: 'cli', thread: values.thread ?? id, text, at: new Date().toISOString() })
  io.out(`cli:${id}`)
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

async function run(args: string[], paths: Paths, io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { 'until-idle': { type: 'boolean' } } })
  const llm = new ClaudeCli(leaderSettings(), paths.leaderCwd)
  const onLockLost = (error: Error) => {
    io.err(`运行锁丢失，退出：${error.message}`)
    process.exit(1)
  }
  const { runtime, release } = await Runtime.open({ paths, llm, onLockLost })
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

const COMMANDS: Record<string, Command> = { project, say, replay, run, status, decisions, report, review }

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
