/** Request reading, fixed JSON envelopes, and the one place internal errors become safe responses. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ActionError } from '../actions.ts'

export const MAX_BODY_BYTES = 128 * 1024

export type HttpErrorCode =
  | 'E_BAD_REQUEST'
  | 'E_UNAUTHORIZED'
  | 'E_FORBIDDEN'
  | 'E_NOT_FOUND'
  | 'E_CONFLICT'
  | 'E_TOO_LARGE'
  | 'E_UNSUPPORTED_MEDIA'
  | 'E_INTERNAL'

const STATUS: Record<HttpErrorCode, number> = {
  E_BAD_REQUEST: 400,
  E_UNAUTHORIZED: 401,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_TOO_LARGE: 413,
  E_UNSUPPORTED_MEDIA: 415,
  E_INTERNAL: 500,
}

export class HttpError extends Error {
  readonly status: number

  constructor(
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
    this.status = STATUS[code]
  }
}

export function requireJsonContentType(header: string | undefined): void {
  if (header?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError('E_UNSUPPORTED_MEDIA', '请求必须是 JSON')
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) tooLarge = true
    else chunks.push(buffer)
  }
  if (tooLarge) throw new HttpError('E_TOO_LARGE', '请求内容太大')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError('E_BAD_REQUEST', 'JSON 格式不正确')
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.setHeader('Cache-Control', 'no-store')
  response.end(body)
}

export function sendError(
  response: ServerResponse,
  error: unknown,
  onError: (error: unknown) => void = (cause) => console.error(cause),
): void {
  if (error instanceof HttpError) {
    if (error.code === 'E_TOO_LARGE') response.shouldKeepAlive = false
    sendJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof ActionError) {
    sendJson(response, STATUS[error.code], { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  onError(error)
  sendJson(response, STATUS.E_INTERNAL, {
    ok: false,
    error: { code: 'E_INTERNAL', message: '服务器内部错误' },
  })
}
