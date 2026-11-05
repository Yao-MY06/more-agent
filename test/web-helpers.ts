import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import type { WebServer } from '../src/web/server.ts'

export interface TestResponse {
  status: number
  headers: OutgoingHttpHeaders
  body: string
}

export function authHeaders(web: WebServer, extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  return {
    Host: `127.0.0.1:${web.address.port}`,
    Authorization: `Bearer ${web.token}`,
    ...extra,
  }
}

export async function request(
  web: WebServer,
  options: { method?: string; path?: string; headers?: OutgoingHttpHeaders; body?: string | Buffer } = {},
): Promise<TestResponse> {
  const body = options.body === undefined ? undefined : Buffer.from(options.body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: web.address.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/api/overview',
        agent: false,
        headers: {
          ...authHeaders(web, options.headers),
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
