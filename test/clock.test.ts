import { describe, expect, it } from 'vitest'
import { monotonicClock } from '../src/clock.ts'
import { localPolicy, localScope } from '../src/policy.ts'
import { ShadowExecutor } from '../src/shadow.ts'
import { toTrigger } from '../src/spool.ts'
import { type Candidate, Engine, MemoryRepositories } from '../vendor/dsh-superagent/src/core/index.ts'

const FROZEN_MS = Date.parse('2026-11-02T00:00:00.000Z')
const request = (id: string) =>
  toTrigger({ id, source: 'cli', thread: 'shared', text: `request ${id}`, at: '2026-11-02T00:00:00.000Z' })

/** The Engine and shadow execution on an in-memory store, with effects run by hand so nothing depends on timing. */
function shadowEngine(now: () => string) {
  const repo = new MemoryRepositories()
  const candidates: Candidate[] = []
  const queue: [string, string, never][] = []
  const handlers = new Map<string, (payload: never, key: string) => Promise<void>>()
  const effects = {
    enqueue: (kind: string, key: string, payload: unknown) => queue.push([kind, key, payload as never]),
    handle: (kind: string, run: (payload: never, key: string) => Promise<void>) => handlers.set(kind, run),
  }
  const engine: Engine = new Engine({
    repo,
    scope: localScope,
    policy: localPolicy,
    assessor: { request: (candidate) => candidates.push(candidate) },
    executor: new ShadowExecutor({ engine: () => engine, effects: effects as never, store: repo }),
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    now,
  })
  const settle = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await handlers.get(next[0])?.(next[2], next[1])
  }
  return { engine, candidates, settle }
}

async function followUpOnRoutedThread(now: () => string): Promise<number> {
  const { engine, candidates, settle } = shadowEngine(now)
  engine.receive(request('1'))
  engine.evaluateDue()
  const [first] = candidates
  if (!first) throw new Error('The first request was not evaluated')
  engine.decide(first.triggers[0]?.id ?? '', {
    kind: 'accept',
    title: 'T',
    scope: 'S',
    reason: 'R',
    evalId: first.evalId,
  })
  await settle()
  engine.receive(request('2'))
  await settle()
  engine.evaluateDue()
  return candidates.length
}

describe('monotonicClock', () => {
  it('when the wall clock stands still, each reading is still later than the last', () => {
    const now = monotonicClock(() => FROZEN_MS)
    const readings = [now(), now(), now()]
    expect(readings[0]).toBe('2026-11-02T00:00:00.000Z')
    expect(readings[1]).toBe('2026-11-02T00:00:00.001Z')
    expect(readings[2]).toBe('2026-11-02T00:00:00.002Z')
  })
  it('when the wall clock moves past the last reading, it follows the wall clock', () => {
    let wall = FROZEN_MS
    const now = monotonicClock(() => wall)
    now()
    wall += 5000
    expect(now()).toBe('2026-11-02T00:00:05.000Z')
  })
  it('when the wall clock jumps back, readings keep moving forward', () => {
    let wall = FROZEN_MS
    const now = monotonicClock(() => wall)
    now()
    wall -= 5000
    expect(now()).toBe('2026-11-02T00:00:00.001Z')
  })
})

describe('a follow-up that shadow execution reads within one millisecond', () => {
  it('reproduces the bug: on a clock that does not advance, the Engine sends the message back for a second Eval', async () => {
    const frozen = () => new Date(FROZEN_MS).toISOString()
    await expect(followUpOnRoutedThread(frozen)).resolves.toBe(2)
  })
  it('with the monotonic clock, it stays with its Ticket and the Leader is not asked again', async () => {
    await expect(followUpOnRoutedThread(monotonicClock(() => FROZEN_MS))).resolves.toBe(1)
  })
})
