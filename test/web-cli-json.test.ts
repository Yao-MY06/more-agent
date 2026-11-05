import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { useHome } from './helpers.ts'

const ROOT = join(import.meta.dirname, '..')
const CLI = join(ROOT, 'lib', 'bin', 'resident.js')
const BUILD_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 30_000
const WAIT_MS = 10_000
const NON_JSON_STDIN_WAIT_MS = 400

const home = useHome()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Output {
  stdout: string
  stderr: string
}

function startWeb(args: string[]): { child: ChildProcess; output: Output } {
  const output = { stdout: '', stderr: '' }
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'web', ...args], {
    env: { ...process.env, RESIDENT_HOME: home().home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => {
    output.stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    output.stderr += String(chunk)
  })
  return { child, output }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > WAIT_MS) throw new Error('Condition did not become true')
    await sleep(50)
  }
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child did not exit')), WAIT_MS)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null) child.kill()
}

async function expectPortReleased(port: number): Promise<void> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

describe('resident web JSON mode', () => {
  beforeAll(() => {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const build = spawnSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(build.status, build.stdout).toBe(0)
  }, BUILD_TIMEOUT_MS)

  it('prints exactly one JSON line and exits when stdin closes', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { child, output } = startWeb(['--port', '0', '--json'])
    try {
      await waitFor(() => output.stdout.includes('\n'))
      const lines = output.stdout.trimEnd().split(/\r?\n/)
      expect(lines).toHaveLength(1)
      const started = JSON.parse(lines[0] ?? '{}') as { url?: string }
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/)
      const port = Number(new URL(started.url ?? 'http://127.0.0.1').port)

      child.stdin?.end()
      expect(await waitForExit(child)).toBe(0)
      expect(output.stdout.trimEnd().split(/\r?\n/)).toHaveLength(1)
      expect(output.stderr).toBe('')
      await expectPortReleased(port)
    } finally {
      killIfRunning(child)
    }
  })

  it('keeps the existing prompt mode alive after stdin closes', { timeout: TEST_TIMEOUT_MS }, async () => {
    const { child, output } = startWeb(['--port', '0'])
    try {
      await waitFor(() => output.stdout.includes('网页面板：') && output.stdout.includes('Ctrl+C 停止'))
      child.stdin?.end()
      await sleep(NON_JSON_STDIN_WAIT_MS)
      expect(child.exitCode).toBeNull()
      const port = Number(/127\.0\.0\.1:(\d+)/.exec(output.stdout)?.[1])
      expect(port).toBeGreaterThan(0)
      child.kill()
      await waitForExit(child)
      await expectPortReleased(port)
    } finally {
      killIfRunning(child)
    }
  })

  it('keeps startup errors on stderr with the usual exit code', { timeout: TEST_TIMEOUT_MS }, async () => {
    const occupied = createNetServer()
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const { child, output } = startWeb(['--port', String(port), '--json'])
    try {
      expect(await waitForExit(child)).toBe(1)
      expect(output.stdout).toBe('')
      expect(output.stderr).toContain('端口')
      expect(output.stderr).toContain('--port')
    } finally {
      killIfRunning(child)
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
