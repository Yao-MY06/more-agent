/** Start and stop the existing panel as a child process, keeping its token inside the pipe. */
import { spawn } from 'node:child_process'

const STARTUP_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 5_000
const FORCE_STOP_TIMEOUT_MS = 1_000
const STDERR_TAIL_CHARS = 2_000
const TOKEN_PATTERN = /^[a-f0-9]{64}$/

function startupError(message) {
  return new Error(`面板服务启动失败：${message}`)
}

function validateUrl(value) {
  if (typeof value !== 'string') throw startupError('没有返回 url。')
  let url
  try {
    url = new URL(value)
  } catch {
    throw startupError('返回的 url 无法解析。')
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
    throw startupError('返回的 url 不是本机 127.0.0.1 面板地址。')
  }
  const token = new URLSearchParams(url.hash.replace(/^#/, '')).get('token')
  if (!token || !TOKEN_PATTERN.test(token)) throw startupError('返回的 url 没有有效令牌。')
  return value
}

function parseLine(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    throw startupError('返回的内容不是合法 JSON。')
  }
  if (!value || typeof value !== 'object') throw startupError('返回的内容不是对象。')
  return validateUrl(value.url)
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  try {
    child.stdin?.end()
  } catch {}
  await withTimeout(waitForExit(child), STOP_TIMEOUT_MS)
  if (child.exitCode !== null) return
  child.kill()
  await withTimeout(waitForExit(child), FORCE_STOP_TIMEOUT_MS)
}

export async function startPanel({ nodePath, cliPath, env, spawnProcess = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(nodePath, [cliPath, 'web', '--port', '0', '--json'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (error, url) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) {
        if (child.exitCode === null) child.kill()
        reject(error)
      } else resolve({ url, child, stop: () => stopChild(child) })
    }
    const onStdout = (chunk) => {
      stdout += String(chunk)
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      try {
        finish(undefined, parseLine(stdout.slice(0, newline).trim()))
      } catch (error) {
        finish(error)
      }
    }
    const onStderr = (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_TAIL_CHARS)
    }
    const onError = (error) => finish(startupError(error.message))
    const onExit = (code) => finish(startupError(`提前退出（退出码 ${code}）${stderr ? `：${stderr.trim()}` : ''}`))
    const timer = setTimeout(() => finish(startupError('15 秒内没有返回面板链接。')), STARTUP_TIMEOUT_MS)
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}
