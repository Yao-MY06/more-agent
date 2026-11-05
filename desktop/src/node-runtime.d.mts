import type { SpawnSyncReturns } from 'node:child_process'

export type RunSync = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; windowsHide: true },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'>

export function resolveNode(env?: NodeJS.ProcessEnv): string
export function assertNodeVersion(nodePath: string, runSync?: RunSync): void
export function resolveCli(root: string): string
