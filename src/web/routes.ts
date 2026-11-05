/** The web routes. Every return value becomes the `data` of a success response. */
import { z } from 'zod'
import { forgetEntry, rememberRule, submitMessage, submitStop } from '../actions.ts'
import { MAX_TEXT_CHARS, type Paths } from '../config.ts'
import { listThreads, readThread } from '../conversations.ts'
import { GLOBAL_SCOPE, projectScope } from '../memory/recorder.ts'
import type { MemoryStore } from '../memory/store.ts'
import { loadProjects } from '../projects.ts'
import { readStatus } from '../report.ts'
import { isRunnerUp } from '../runner-state.ts'
import { pendingSpoolItems, THREAD_ID_PATTERN } from '../spool.ts'
import { readTickets } from '../tickets-view.ts'
import { HttpError } from './http.ts'

const MAX_LIMIT = 100
const MIN_LIMIT = 1
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const LIMIT = z.coerce.number().int().min(MIN_LIMIT).max(MAX_LIMIT)
const SOURCE_THREAD_PATTERN = /^(?:cli|replay):[\w.-]{1,120}$/

const LimitQuerySchema = z.object({ limit: LIMIT.default(MAX_LIMIT) }).strict()
const MemoryQuerySchema = z
  .object({
    q: z.string().trim().max(MAX_TEXT_CHARS).optional(),
    project: z.string().regex(PROJECT_ID_PATTERN).optional(),
    limit: LIMIT.default(MAX_LIMIT),
  })
  .strict()
const MessageBodySchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_TEXT_CHARS),
    thread: z.union([z.string().regex(SOURCE_THREAD_PATTERN), z.string().regex(THREAD_ID_PATTERN)]).optional(),
  })
  .strict()
const StopBodySchema = z.object({ reason: z.string().max(MAX_TEXT_CHARS).optional() }).strict()
const RememberBodySchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_TEXT_CHARS),
    project: z.string().regex(PROJECT_ID_PATTERN).optional(),
    supersedes: z.string().min(1).optional(),
  })
  .strict()
const ForgetBodySchema = z.object({ reason: z.string().max(MAX_TEXT_CHARS).optional() }).strict()

export interface RouteContext {
  paths: Paths
  memory: MemoryStore
  params: string[]
  query: URLSearchParams
  body: unknown
}

export interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  bodySchema?: z.ZodType
  handle(context: RouteContext): Promise<unknown> | unknown
}

function queryOf(query: URLSearchParams): Record<string, string> {
  return Object.fromEntries(query)
}

function parseQuery<T>(schema: z.ZodType<T>, query: URLSearchParams): T {
  const parsed = schema.safeParse(queryOf(query))
  if (!parsed.success) throw new HttpError('E_BAD_REQUEST', '查询参数不正确')
  return parsed.data
}

function threadBody(body: unknown): z.infer<typeof MessageBodySchema> {
  return body as z.infer<typeof MessageBodySchema>
}

function stopBody(body: unknown): z.infer<typeof StopBodySchema> {
  return body as z.infer<typeof StopBodySchema>
}

function rememberBody(body: unknown): z.infer<typeof RememberBodySchema> {
  return body as z.infer<typeof RememberBodySchema>
}

function forgetBody(body: unknown): z.infer<typeof ForgetBodySchema> {
  return body as z.infer<typeof ForgetBodySchema>
}

function sendMessage(paths: Paths, body: unknown): { triggerId: string; threadKey: string } {
  const input = threadBody(body)
  if (input.thread?.startsWith('replay:')) throw new HttpError('E_CONFLICT', '回放话题只读，不能发送')
  const thread = input.thread?.startsWith('cli:') ? input.thread.slice('cli:'.length) : input.thread
  return submitMessage(paths, { text: input.text, ...(thread === undefined ? {} : { thread }) })
}

function listMemory(memory: MemoryStore, query: URLSearchParams): { entries: unknown[] } {
  const input = parseQuery(MemoryQuerySchema, query)
  const scopes = input.project ? [GLOBAL_SCOPE, projectScope(input.project)] : undefined
  if (input.q) {
    const options = { limit: input.limit, ...(scopes ? { scopes } : {}) }
    return { entries: memory.search(input.q, options) }
  }
  const entries = memory.list(MAX_LIMIT).filter((entry) => !scopes || scopes.includes(entry.scope))
  return { entries: entries.slice(0, input.limit) }
}

function getMemory(memory: MemoryStore, id: string): { entry: unknown } {
  const entry = memory.get(id)
  if (!entry || entry.supersededBy) throw new HttpError('E_NOT_FOUND', `没有这条记忆：${id}`)
  return { entry }
}

const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/overview$/,
    async handle({ paths }) {
      return {
        runnerUp: await isRunnerUp(paths),
        status: readStatus(paths, pendingSpoolItems(paths).length),
        projects: loadProjects(paths.projects).map(({ id, execute }) => ({ id, execute })),
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/threads$/,
    handle({ paths, query }) {
      return { threads: listThreads(paths, parseQuery(LimitQuerySchema, query).limit) }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/threads\/([^/]+)\/messages$/,
    handle({ paths, query, params }) {
      const key = params[0] ?? ''
      return { messages: readThread(paths, key, parseQuery(LimitQuerySchema, query).limit) }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/messages$/,
    bodySchema: MessageBodySchema,
    handle({ paths, body }) {
      return sendMessage(paths, body)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/tickets$/,
    handle({ paths }) {
      return { tickets: readTickets(paths) }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/tickets\/([^/]+)\/stop$/,
    bodySchema: StopBodySchema,
    handle({ paths, params, body }) {
      const ticketId = params[0] ?? ''
      return submitStop(paths, { ticketId, ...stopBody(body) })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/memory$/,
    handle({ memory, query }) {
      return listMemory(memory, query)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/memory\/([^/]+)$/,
    handle({ memory, params }) {
      return getMemory(memory, params[0] ?? '')
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/memory$/,
    bodySchema: RememberBodySchema,
    handle({ paths, memory, body }) {
      return rememberRule(paths, memory, rememberBody(body))
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/memory\/([^/]+)\/forget$/,
    bodySchema: ForgetBodySchema,
    handle({ memory, params, body }) {
      const id = params[0] ?? ''
      return forgetEntry(memory, { id, ...forgetBody(body) })
    },
  },
]

export function matchRoute(method: string, pathname: string): { route: Route; params: string[] } | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue
    const match = route.pattern.exec(pathname)
    if (match) return { route, params: match.slice(1) }
  }
  return undefined
}
