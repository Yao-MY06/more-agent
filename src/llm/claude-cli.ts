/** A Leader call through `claude -p`: one stateless, tool-less process per request. */
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { LEADER_CALL_TIMEOUT_MS, type LeaderSettings } from '../config.ts'
import type { Llm, LlmRequest, LlmResult } from './llm.ts'
import { type Invocation, resolveInvocation } from './resolve-command.ts'

const MAX_OUTPUT_CHARS = 2_000_000
const ERROR_EXCERPT_CHARS = 500

const ResultSchema = z.looseObject({
  is_error: z.boolean().optional(),
  result: z.unknown().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
})

/** `--restricted --tools ""` makes the no-shell rule a hard boundary: upstream's main Session only had it as a prompt rule. */
export function claudeArguments(settings: LeaderSettings, request: LlmRequest): string[] {
  return [
    '-p',
    '--model',
    settings.model,
    '--effort',
    settings.effort,
    '--restricted',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(request.schema),
    '--system-prompt',
    request.system,
  ]
}

export function parseClaudeResult(stdout: string): LlmResult {
  const result = ResultSchema.parse(JSON.parse(stdout))
  if (result.is_error) throw new Error(`The Leader call failed: ${String(result.result).slice(0, ERROR_EXCERPT_CHARS)}`)
  if (result.structured_output === undefined) throw new Error('The Leader call returned no structured output')
  return {
    output: result.structured_output,
    usage: {
      inputTokens: result.usage?.input_tokens ?? 0,
      cacheReadTokens: result.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: result.usage?.cache_creation_input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      costUsd: result.total_cost_usd ?? 0,
      durationMs: result.duration_ms ?? 0,
    },
  }
}

export class ClaudeCli implements Llm {
  private readonly settings: LeaderSettings
  private readonly cwd: string
  constructor(settings: LeaderSettings, cwd: string) {
    this.settings = settings
    this.cwd = cwd
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResult> {
    const [command, ...prefix] = this.settings.command
    const args = [...prefix, ...claudeArguments(this.settings, request)]
    const invocation = command && resolveInvocation(command, args)
    if (!invocation) throw new Error(`Command not found: ${command}`)
    return parseClaudeResult(await run(invocation, this.cwd, request.user, signal))
  }
}

/** The request goes through stdin, so what a person wrote never meets a command line. */
function run(invocation: Invocation, cwd: string, input: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      windowsHide: true,
      timeout: LEADER_CALL_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < ERROR_EXCERPT_CHARS) stderr += chunk
    })
    let failure: Error | undefined
    child.on('error', (error) => {
      failure = error
    })
    // A process that dies early closes stdin first; its exit reports that, not the broken pipe.
    child.stdin.on('error', () => {})
    // Settling on close, not on the error, means a cancelled call has really ended and holds no file or directory.
    child.on('close', (code) => {
      if (failure) reject(failure)
      else if (code === 0) resolve(stdout)
      else reject(new Error(`The Leader call exited with ${code}: ${(stderr || stdout).slice(0, ERROR_EXCERPT_CHARS)}`))
    })
    child.stdin.end(input)
  })
}
