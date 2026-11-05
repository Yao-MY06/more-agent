import type { ChildProcess } from 'node:child_process'

export interface PanelProcess {
  url: string
  child: ChildProcess
  stop(): Promise<void>
}

export type SpawnProcess = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess

export interface StartPanelOptions {
  nodePath: string
  cliPath: string
  env: NodeJS.ProcessEnv
  spawnProcess?: SpawnProcess
}

export function startPanel(options: StartPanelOptions): Promise<PanelProcess>
