/**
 * Resolves a CLI on PATH so it can run without cmd.exe, which mangles quotes, `%`, `&` and non-ASCII text. npm installs most
 * CLIs on Windows as `.cmd` shims that Node refuses to spawn without a shell, so a shim runs as `node <script>` directly.
 * Ported from opus-manager's harness/src/spawn.js.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const NODE_SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '']

export interface Invocation {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(command) || command.includes('/') || (IS_WINDOWS && command.includes('\\'))) {
    return existsSync(command) ? resolve(command) : undefined
  }
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const extensions = IS_WINDOWS ? (env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean) : ['']
  for (const directory of directories) {
    const found = extensions.map((extension) => join(directory, command + extension.toLowerCase())).find(isFile)
    if (found) return found
  }
  return undefined
}

/** The script an npm cmd-shim runs, if the file is one. */
export function parseNpmShim(shim: string): string | undefined {
  const match = readFileSync(shim, 'utf8').match(/"%~?dp0%?\\([^"]+?)"\s*%\*/i)
  if (!match?.[1]) return undefined
  const target = join(dirname(shim), ...match[1].split(/[\\/]+/))
  return existsSync(target) ? target : undefined
}

function escapeMeta(text: string): string {
  return text.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1')
}

function escapeArgument(argument: string): string {
  const quoted = argument
    .replace(/[\r\n]+/g, ' ')
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, '$1$1')
  return escapeMeta(escapeMeta(`"${quoted}"`))
}

function viaShim(shim: string, args: string[]): Invocation | undefined {
  const target = parseNpmShim(shim)
  if (!target) return undefined
  const extension = extname(target).toLowerCase()
  if (extension === '.exe') return { file: target, args }
  if (!NODE_SCRIPT_EXTENSIONS.includes(extension)) return undefined
  const localNode = join(dirname(shim), 'node.exe')
  return { file: existsSync(localNode) ? localNode : process.execPath, args: [target, ...args] }
}

export function resolveInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Invocation | undefined {
  const resolved = which(command, env)
  if (!resolved) return undefined
  const extension = extname(resolved).toLowerCase()
  if (!IS_WINDOWS || (extension !== '.cmd' && extension !== '.bat')) return { file: resolved, args }
  const direct = viaShim(resolved, args)
  if (direct) return direct
  const line = [escapeMeta(resolved), ...args.map(escapeArgument)].join(' ')
  return {
    file: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}
