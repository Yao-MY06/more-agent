/** The local panel process: one loopback listener, fresh token, read-only state views. */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ZodError } from 'zod'
import type { Paths } from '../config.ts'
import { MemoryStore } from '../memory/store.ts'
import { HttpError, readJsonBody, requireJsonContentType, sendError, sendJson } from './http.ts'
import { matchRoute } from './routes.ts'
import { applySecurityHeaders, checkAuthorization, checkHost, checkOrigin } from './security.ts'
import { type StaticAsset, staticAsset } from './static.ts'

export const DEFAULT_PORT = 4517
const LOOPBACK = '127.0.0.1'

export interface WebServer {
  url: string
  token: string
  address: AddressInfo
  close(): Promise<void>
}

interface ServerOptions {
  paths: Paths
  port?: number
  onError?: (error: unknown) => void
}

function sendStatic(response: ServerResponse, asset: StaticAsset): void {
  if (!existsSync(asset.file)) throw new HttpError('E_NOT_FOUND', '页面文件不存在')
  const body = readFileSync(asset.file)
  response.statusCode = 200
  response.setHeader('Content-Type', asset.contentType)
  response.setHeader('Content-Length', body.length)
  response.setHeader('Cache-Control', 'no-cache')
  response.end(body)
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function decodeParams(params: string[]): string[] {
  try {
    return params.map(decodeURIComponent)
  } catch {
    throw new HttpError('E_BAD_REQUEST', '路径参数不正确')
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  paths: Paths,
  memory: MemoryStore,
  token: string,
  port: number,
  onError: (error: unknown) => void,
): Promise<void> {
  applySecurityHeaders(response)
  try {
    checkHost(header(request, 'host'), port)
    const url = new URL(request.url ?? '/', `http://${LOOPBACK}:${port}`)
    const asset = staticAsset(url.pathname)
    if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
      sendStatic(response, asset)
      return
    }

    checkOrigin(header(request, 'origin'), port)
    checkAuthorization(header(request, 'authorization'), token)
    let body: unknown
    if (request.method === 'POST') {
      requireJsonContentType(header(request, 'content-type'))
      body = await readJsonBody(request)
    }
    const matched = matchRoute(request.method ?? 'GET', url.pathname)
    if (!matched) throw new HttpError('E_NOT_FOUND', '没有这个接口')
    try {
      body = matched.route.bodySchema?.parse(body)
    } catch (error) {
      if (error instanceof ZodError) throw new HttpError('E_BAD_REQUEST', '参数不正确')
      throw error
    }
    const data = await matched.route.handle({
      paths,
      memory,
      params: decodeParams(matched.params),
      query: url.searchParams,
      body,
    })
    sendJson(response, 200, { ok: true, data })
  } catch (error) {
    sendError(response, error, onError)
  }
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, LOOPBACK, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

export async function startWebServer(options: ServerOptions): Promise<WebServer> {
  const token = randomBytes(32).toString('hex')
  const memory = new MemoryStore(options.paths.memory)
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  let port = options.port ?? DEFAULT_PORT
  const server = createServer((request, response) => {
    void handleRequest(request, response, options.paths, memory, token, port, onError)
  })
  try {
    await listen(server, port)
  } catch (error) {
    memory.close()
    if (server.listening) server.close()
    throw error
  }
  const address = server.address() as AddressInfo
  port = address.port
  server.on('error', onError)
  let closed = false
  return {
    url: `http://${LOOPBACK}:${port}/#token=${token}`,
    token,
    address,
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      memory.close()
    },
  }
}
