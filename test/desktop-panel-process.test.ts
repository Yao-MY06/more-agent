import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertNodeVersion, resolveCli, resolveNode } from '../desktop/src/node-runtime.mjs'
import { startPanel } from '../desktop/src/panel-process.mjs'

const STARTUP_TIMEOUT_MS = 15_000
const PANEL_URL = 'http://127.0.0.1:53124/#token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const tempDirs: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const directory of tempDirs.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'resident-desktop-test-'))
  tempDirs.push(directory)
  return directory
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
    final: (callback) => {
      if (this.exitOnStdin) this.emit('exit', 0, null)
      callback()
    },
  })
  exitCode: number | null = null
  killed = false

  constructor(readonly exitOnStdin = true) {
    super()
    this.once('exit', (code: number | null) => {
      this.exitCode = code
    })
  }

  kill(): boolean {
    this.killed = true
    if (this.exitCode === null) this.emit('exit', null, 'SIGTERM')
    return true
  }
}

describe('desktop Node runtime', () => {
  it('prefers RESIDENT_NODE and reports a missing system Node in Chinese', () => {
    expect(resolveNode({ RESIDENT_NODE: 'C:\\node\\node.exe' } as NodeJS.ProcessEnv)).toBe('C:\\node\\node.exe')
    expect(() => resolveNode({ PATH: '', Path: '' } as NodeJS.ProcessEnv)).toThrow('找不到系统 Node')

    const root = tempDir()
    const name = process.platform === 'win32' ? 'node.exe' : 'node'
    const executable = join(root, name)
    writeFileSync(executable, '')
    expect(resolveNode({ PATH: root, Path: '' } as NodeJS.ProcessEnv)).toBe(executable)
  })

  it('accepts Node 24.13 and newer 24.x, and rejects older or next-major Node', () => {
    const run = (stdout: string, status = 0) => vi.fn(() => ({ status, stdout, stderr: '' }))
    expect(() => assertNodeVersion('node', run('v24.13.0\n'))).not.toThrow()
    expect(() => assertNodeVersion('node', run('v24.22.0\n'))).not.toThrow()
    expect(() => assertNodeVersion('node', run('v24.12.0\n'))).toThrow('Node 24.13')
    expect(() => assertNodeVersion('node', run('v25.0.0\n'))).toThrow('Node 24.13')
    expect(() => assertNodeVersion('node', run('', 1))).toThrow('无法读取 Node 版本')
    expect(() => assertNodeVersion(process.execPath)).not.toThrow()
  })

  it('finds the built CLI and explains how to build it when missing', () => {
    const root = tempDir()
    expect(() => resolveCli(root)).toThrow('npm run build')
    const cli = join(root, 'lib', 'bin', 'resident.js')
    mkdirSync(join(root, 'lib', 'bin'), { recursive: true })
    writeFileSync(cli, '')
    expect(resolveCli(root)).toBe(cli)
  })
})

describe('panel process', () => {
  const base = () => ({ nodePath: 'node.exe', cliPath: 'lib/bin/resident.js', env: { RESIDENT_HOME: 'C:\\state' } })

  it('starts the JSON CLI, returns the URL, and stops through stdin', async () => {
    const child = new FakeChild()
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ url: PANEL_URL })}\n`))
      return child as unknown as ChildProcess
    })
    const panel = await startPanel({ ...base(), spawnProcess })
    expect(panel.url).toBe(PANEL_URL)
    expect(spawnProcess).toHaveBeenCalledWith('node.exe', ['lib/bin/resident.js', 'web', '--port', '0', '--json'], {
      env: { RESIDENT_HOME: 'C:\\state' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    await panel.stop()
    expect(child.exitCode).toBe(0)
  })

  it('times out when no URL arrives', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const pending = startPanel({ ...base(), spawnProcess: () => child as unknown as ChildProcess })
    const failure = expect(pending).rejects.toThrow('15 秒')
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS)
    await failure
    expect(child.killed).toBe(true)
  })

  it('force-kills a panel that does not exit after stdin closes', async () => {
    const child = new FakeChild(false)
    const panel = await startPanel({
      ...base(),
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ url: PANEL_URL })}\n`))
        return child as unknown as ChildProcess
      },
    })
    vi.useFakeTimers()
    const stopping = panel.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await stopping
    expect(child.killed).toBe(true)
    expect(child.exitCode).toBeNull()
  })

  it('reports early exit with the stderr tail', async () => {
    const child = new FakeChild()
    const pending = startPanel({
      ...base(),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stderr.write('panel failed')
          child.emit('exit', 1, null)
        })
        return child as unknown as ChildProcess
      },
    })
    await expect(pending).rejects.toThrow('panel failed')
  })

  it('rejects malformed JSON and non-local panel URLs', async () => {
    for (const [line, message] of [
      ['not json\n', 'JSON'],
      ['{}\n', 'url'],
      [`${JSON.stringify({ url: 'http://127.0.0.1.evil.example:53124/#token=x' })}\n`, '127.0.0.1'],
      [`${JSON.stringify({ url: 'http://127.0.0.1:53124/#token=x' })}\n`, '令牌'],
      [`${JSON.stringify({ url: 'not a url' })}\n`, '无法解析'],
    ]) {
      const child = new FakeChild()
      const pending = startPanel({
        ...base(),
        spawnProcess: () => {
          queueMicrotask(() => child.stdout.write(line))
          return child as unknown as ChildProcess
        },
      })
      await expect(pending).rejects.toThrow(message)
      expect(child.killed).toBe(true)
    }
  })
})
