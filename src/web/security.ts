/** Local-only request checks: Host, Origin, bearer token, and headers every response carries. */
import { timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { HttpError } from './http.ts'

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function localOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

function localHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`]
}

export function checkHost(header: string | undefined, port: number): void {
  if (!header || !localHosts(port).includes(header.toLowerCase())) {
    throw new HttpError('E_FORBIDDEN', '只允许从本机访问')
  }
}

export function checkOrigin(header: string | undefined, port: number): void {
  if (header && !localOrigins(port).includes(header.toLowerCase())) {
    throw new HttpError('E_FORBIDDEN', '请求来源不正确')
  }
}

function tokenMatches(value: string, token: string): boolean {
  const actual = Buffer.from(value)
  const expected = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function checkAuthorization(header: string | undefined, token: string): void {
  const match = /^Bearer (.+)$/i.exec(header ?? '')
  if (!match?.[1] || !tokenMatches(match[1], token)) {
    throw new HttpError('E_UNAUTHORIZED', '令牌缺失或错误')
  }
}

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', CSP)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
}
