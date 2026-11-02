/** The port a Leader call goes through. */
export interface LlmRequest {
  system: string
  user: string
  /** JSON Schema of the structured reply. */
  schema: object
}

export interface LlmUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** List price the CLI reports, which is not what a subscription pays. */
  costUsd: number
  durationMs: number
}

export interface LlmResult {
  output: unknown
  usage: LlmUsage
}

export interface Llm {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResult>
}
