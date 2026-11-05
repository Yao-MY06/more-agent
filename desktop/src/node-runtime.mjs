/** Finding the system Node that runs the panel, never Electron's process.execPath. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const MIN_NODE_MAJOR = 24
const MIN_NODE_MINOR = 13
const MAX_NODE_MAJOR = 25

function executableNames() {
  return process.platform === 'win32' ? ['node.exe', 'node'] : ['node']
}

export function resolveNode(env = process.env) {
  if (env.RESIDENT_NODE) return env.RESIDENT_NODE
  const searchPath = env.PATH ?? env.Path ?? ''
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    for (const name of executableNames()) {
      const candidate = join(directory.replace(/^"|"$/g, ''), name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('找不到系统 Node。请安装 Node 24.13，或设置 RESIDENT_NODE 指向 node.exe。')
}

function defaultRunSync(file, args, options) {
  return spawnSync(file, args, options)
}

export function assertNodeVersion(nodePath, runSync = defaultRunSync) {
  const result = runSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true })
  const version = String(result.stdout ?? '').trim()
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (result.status !== 0 || !match) {
    throw new Error(`无法读取 Node 版本（${version || '没有输出'}）。请安装 Node 24.13。`)
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const supported =
    major === MIN_NODE_MAJOR ? minor >= MIN_NODE_MINOR : major > MIN_NODE_MAJOR && major < MAX_NODE_MAJOR
  if (!supported) {
    throw new Error(`Node 版本不合适：${version}。需要 Node 24.13 或更新的 24.x。`)
  }
}

export function resolveCli(root) {
  const cli = join(root, 'lib', 'bin', 'resident.js')
  if (!existsSync(cli)) throw new Error('找不到面板服务，请先在 resident 目录运行 npm run build。')
  return cli
}
