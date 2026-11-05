import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWebServer, type WebServer } from '../src/web/server.ts'
import { useHome } from './helpers.ts'
import { request } from './web-helpers.ts'

const home = useHome()
let web: WebServer | undefined

afterEach(async () => {
  await web?.close()
  web = undefined
  vi.restoreAllMocks()
})

async function started(onError?: (error: unknown) => void): Promise<WebServer> {
  web = await startWebServer({ paths: home(), port: 0, ...(onError ? { onError } : {}) })
  return web
}

function expectSecure(response: Awaited<ReturnType<typeof request>>): void {
  expect(response.headers['access-control-allow-origin']).toBeUndefined()
  expect(response.headers['content-security-policy']).toContain("default-src 'none'")
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  expect(response.headers['referrer-policy']).toBe('no-referrer')
}

describe('web security', () => {
  it('rejects a missing or wrong bearer token with 401', async () => {
    const server = await started()
    const missing = await request(server, { headers: { Authorization: '' } })
    const wrong = await request(server, { headers: { Authorization: 'Bearer wrong' } })
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(JSON.parse(missing.body)).toMatchObject({ ok: false, error: { code: 'E_UNAUTHORIZED' } })
    expectSecure(missing)
    expectSecure(wrong)
  })

  it('rejects a foreign Host on both API and static paths with 403', async () => {
    const server = await started()
    for (const path of ['/api/overview', '/app.js']) {
      const response = await request(server, { path, headers: { Host: 'evil.example' } })
      expect(response.status).toBe(403)
      expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } })
      expectSecure(response)
    }
  })

  it('rejects a foreign Origin even with the right token', async () => {
    const server = await started()
    const response = await request(server, { headers: { Origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } })
    expectSecure(response)
  })

  it('rejects a non-JSON POST with 415', async () => {
    const server = await started()
    const response = await request(server, {
      method: 'POST',
      path: '/api/messages',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(response.status).toBe(415)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: 'E_UNSUPPORTED_MEDIA' } })
    expectSecure(response)
  })

  it('rejects a request body over 128 KiB with 413', async () => {
    const server = await started()
    const response = await request(server, {
      method: 'POST',
      path: '/api/messages',
      headers: { 'Content-Type': 'application/json' },
      body: `{"text":"${'a'.repeat(131_073)}"}`,
    })
    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, error: { code: 'E_TOO_LARGE' } })
    expectSecure(response)
  })

  it('does not serve package files through path traversal forms', async () => {
    const server = await started()
    for (const path of ['/../package.json', '/..%2fpackage.json', '/package.json']) {
      const response = await request(server, { path })
      expect(response.status).toBe(404)
      expect(response.body).not.toContain('more-agent-resident')
      expectSecure(response)
    }
  })

  it('binds only to 127.0.0.1', async () => {
    const server = await started()
    expect(server.address.address).toBe('127.0.0.1')
    expect(server.address.family).toBe('IPv4')
  })

  it('does not return exception details on an internal error', async () => {
    writeFileSync(home().projects, '{broken json')
    const onError = vi.fn()
    const server = await started(onError)
    const response = await request(server)
    expect(response.status).toBe(500)
    expect(JSON.parse(response.body)).toMatchObject({
      ok: false,
      error: { code: 'E_INTERNAL', message: '服务器内部错误' },
    })
    expect(response.body).not.toContain('JSON')
    expect(onError).toHaveBeenCalledOnce()
    expectSecure(response)
  })

  it('accepts only the local Host and Origin for the running port', async () => {
    const server = await started()
    const localHost = `localhost:${server.address.port}`
    const localOrigin = `http://127.0.0.1:${server.address.port}`
    const response = await request(server, { headers: { Host: localHost, Origin: localOrigin } })
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
