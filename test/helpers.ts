import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { type Paths, pathsFor } from '../src/config.ts'
import type { Verdict } from '../src/leader/verdict.ts'
import type { Llm, LlmRequest, LlmResult, LlmUsage } from '../src/llm/llm.ts'

/** A fresh state home per test. Retries because a killed process on Windows can hold files for a moment. */
export function useHome(): () => Paths {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'resident-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  return () => pathsFor(home)
}

export const usage: LlmUsage = {
  inputTokens: 1,
  cacheReadTokens: 2,
  cacheWriteTokens: 3,
  outputTokens: 4,
  costUsd: 0.5,
  durationMs: 2000,
}

export function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    action: 'route',
    project: 'alpha',
    title: 'A title',
    scope: 'The request',
    reason: 'A reason',
    acknowledgement: 'On it.',
    question: null,
    confidence: 0.9,
    ...overrides,
  }
}

/** Answers from a script of replies, in order, and records each request it got. */
export class ScriptedLlm implements Llm {
  readonly requests: LlmRequest[] = []
  private readonly replies: (() => unknown)[]
  constructor(...replies: (() => unknown)[]) {
    this.replies = replies
  }
  async complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request)
    const reply = this.replies.length > 1 ? this.replies.shift() : this.replies[0]
    if (!reply) throw new Error('The script has no reply')
    return { output: reply(), usage }
  }
}
