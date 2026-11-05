import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
export const BROWSER_PATH = existsSync(CHROME) ? CHROME : existsSync(EDGE) ? EDGE : undefined
const BROWSER_LOCK_DIRECTORY = join(tmpdir(), 'resident-browser-tests')

interface DevToolsTarget {
  type: string
  webSocketDebuggerUrl: string
}

interface PendingCall {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface EvaluationResult {
  exceptionDetails?: { text?: string }
  result?: { value?: unknown }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!existsSync(file)) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${file}`)
    await sleep(50)
  }
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('DevTools socket failed')), { once: true })
  })
  return socket
}

export class BrowserSession {
  private readonly process: ChildProcess
  private readonly profile: string
  private readonly socket: WebSocket
  private readonly releaseLock: () => Promise<void>
  private readonly pending = new Map<number, PendingCall>()
  readonly errors: string[] = []
  private nextId = 1

  constructor(process: ChildProcess, profile: string, socket: WebSocket, releaseLock: () => Promise<void>) {
    this.process = process
    this.profile = profile
    this.socket = socket
    this.releaseLock = releaseLock
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        method?: string
        error?: { message?: string }
        result?: unknown
        params?: Record<string, unknown>
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message ?? 'DevTools call failed'))
        else pending.resolve(message.result)
        return
      }
      const params = message.params as
        | {
            exceptionDetails?: { text?: string }
            type?: string
            args?: { value?: unknown; description?: string }[]
            entry?: { level?: string; text?: string }
          }
        | undefined
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(params?.exceptionDetails?.text ?? 'exception')
      if (message.method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
        this.errors.push((params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' '))
      }
      if (message.method === 'Log.entryAdded' && params?.entry?.level === 'error') {
        this.errors.push(params.entry.text ?? 'browser log error')
      }
    })
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send<EvaluationResult>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed')
    return result.result?.value
  }

  async waitFor(expression: string, timeoutMs = 10_000): Promise<void> {
    const started = Date.now()
    while (!(await this.evaluate(expression))) {
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${expression}`)
      await sleep(100)
    }
  }

  async setValue(selector: string, value: string): Promise<void> {
    await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) throw new Error('Missing element: ' + ${JSON.stringify(selector)})
      node.value = ${JSON.stringify(value)}
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) throw new Error('Missing element: ' + ${JSON.stringify(selector)})
      node.click()
    })()`)
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    return Buffer.from(result.data, 'base64')
  }

  async close(): Promise<void> {
    try {
      await this.send('Browser.close')
    } catch {}
    await new Promise<void>((resolve) => {
      if (this.process.exitCode !== null) return resolve()
      const timeout = setTimeout(() => {
        this.process.kill()
        resolve()
      }, 3000)
      this.process.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    this.socket.close()
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(this.profile, { recursive: true, force: true })
        break
      } catch {
        await sleep(200)
      }
    }
    await this.releaseLock()
  }
}

export async function launchBrowser(url: string): Promise<BrowserSession> {
  if (!BROWSER_PATH) throw new Error('No Chromium browser is available')
  mkdirSync(BROWSER_LOCK_DIRECTORY, { recursive: true })
  const releaseLock = await lock(BROWSER_LOCK_DIRECTORY, {
    stale: 120_000,
    retries: { retries: 600, minTimeout: 100, maxTimeout: 100 },
  })
  const profile = mkdtempSync(join(tmpdir(), 'resident-cdp-'))
  const chrome = spawn(
    BROWSER_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      '--window-size=1400,900',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  try {
    const activePort = join(profile, 'DevToolsActivePort')
    await waitForFile(activePort)
    const contents = await readFile(activePort, 'utf8')
    const port = Number(contents.split('\n')[0])
    const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    )) as DevToolsTarget[]
    const page = targets.find((target) => target.type === 'page')
    if (!page) throw new Error('Chrome did not expose a page target')
    const socket = await openSocket(page.webSocketDebuggerUrl)
    const session = new BrowserSession(chrome, profile, socket, releaseLock)
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    await session.send('Log.enable')
    await session.send('Page.navigate', { url })
    await session.waitFor("document.readyState === 'complete'", 10_000)
    return session
  } catch (error) {
    chrome.kill()
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {}
    }, 500)
    await releaseLock()
    throw error
  }
}
