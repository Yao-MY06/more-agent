import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { addProject } from '../src/projects.ts'
import { decisionRows, readStatus, readSummary, renderReport } from '../src/report.ts'
import { Runtime } from '../src/runtime.ts'
import { writeSpool } from '../src/spool.ts'
import { ScriptedLlm, useHome, verdict } from './helpers.ts'

const home = useHome()
const at = '2026-11-02T00:00:00.000Z'
const IDLE_LIMIT_MS = 15_000
/** Long enough to sit out the first retry's backoff. */
const RETRY_TEST_TIMEOUT_MS = 20_000
const request = (id: string, thread = id, text = `request ${id}`) => ({ id, source: 'cli' as const, thread, text, at })

async function run(llm: ScriptedLlm, limitMs = IDLE_LIMIT_MS): Promise<void> {
  const { runtime, release } = await Runtime.open({
    paths: home(),
    llm,
    onLockLost: (error) => {
      throw error
    },
  })
  try {
    await runtime.runUntilIdle(undefined, limitMs)
  } finally {
    await runtime.close()
    await release()
  }
}

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) } }
}

describe('shadow routing through the upstream Engine', () => {
  it('when a request is routed, the Decision records the project and nothing is sent', async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: 'Alpha project' })
    writeSpool(home(), request('1'))
    const llm = new ScriptedLlm(() => verdict())
    await run(llm)
    expect(llm.requests).toHaveLength(1)
    expect(decisionRows(home())).toMatchObject([{ triggerId: 'cli:1', outcome: 'alpha', wouldSay: 'On it.' }])
    expect(readStatus(home(), 0)).toMatchObject({
      triggers: 1,
      tickets: 1,
      wouldSay: 1,
      sent: 0,
      effects: 0,
      activeThreads: 0,
    })
  })

  it('when the same request arrives twice, the Leader judges it once', async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: '' })
    writeSpool(home(), request('1'))
    const llm = new ScriptedLlm(() => verdict())
    await run(llm)
    writeSpool(home(), request('1'))
    await run(llm)
    expect(llm.requests).toHaveLength(1)
    expect(decisionRows(home())).toHaveLength(1)
  })

  it('when a follow-up arrives on a routed thread, it reaches the Ticket without a Leader call', async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: '' })
    writeSpool(home(), request('1', 'shared'))
    const llm = new ScriptedLlm(() => verdict())
    await run(llm)
    writeSpool(home(), { ...request('2', 'shared'), at: '2026-11-02T00:00:01.000Z' })
    await run(llm)
    expect(llm.requests).toHaveLength(1)
    expect(readSummary(home()).summary).toMatchObject({ decisions: 1, direct: 1 })
  })

  it('when a thread continues after a clarify, the Leader sees the earlier message', async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: '' })
    writeSpool(home(), request('1', 'shared', 'fix the bug'))
    const llm = new ScriptedLlm(
      () => verdict({ action: 'clarify', project: null, question: 'Which project?' }),
      () => verdict(),
    )
    await run(llm)
    writeSpool(home(), { ...request('2', 'shared', 'the alpha one'), at: '2026-11-02T00:00:01.000Z' })
    await run(llm)
    const card = JSON.parse(llm.requests[1]?.user ?? '{}')
    expect(card.thread.map((value: { text: string }) => value.text)).toEqual(['fix the bug'])
    expect(decisionRows(home()).map((row) => row.outcome)).toEqual(['clarify', 'alpha'])
  })

  it('when the Leader answers badly, the call retries and only the good answer is recorded', {
    timeout: RETRY_TEST_TIMEOUT_MS,
  }, async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: '' })
    writeSpool(home(), request('1'))
    const llm = new ScriptedLlm(
      () => verdict({ project: 'ghost' }),
      () => verdict(),
    )
    await run(llm)
    expect(llm.requests).toHaveLength(2)
    expect(decisionRows(home()).map((row) => row.outcome)).toEqual(['alpha'])
  })

  it('when the Leader keeps failing, the runner reports waiting work instead of hanging', async () => {
    writeSpool(home(), request('1'))
    const llm = new ScriptedLlm(() => {
      throw new Error('quota')
    })
    await expect(run(llm, 1000)).rejects.toThrow('still waiting')
    expect(decisionRows(home())).toEqual([])
    expect(readStatus(home(), 0).triggers).toBe(1)
  })

  it('when a runner holds the home, a second one cannot write at the same time', async () => {
    const options = {
      paths: home(),
      llm: new ScriptedLlm(() => verdict()),
      onLockLost: (error: Error) => {
        throw error
      },
    }
    const first = await Runtime.open(options)
    const lockedOut = new Promise((resolve) => {
      Runtime.open(options).then(
        async (second) => {
          await second.runtime.close()
          await second.release()
          resolve('opened')
        },
        () => resolve('refused'),
      )
      setTimeout(() => resolve('waiting'), 1500)
    })
    await expect(lockedOut).resolves.toBe('waiting')
    await first.runtime.close()
    await first.release()
    await new Promise((resolve) => setTimeout(resolve, 1500))
  })

  it('the rendered report shows the outcome and what the expected answer was', async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: '' })
    writeSpool(home(), { ...request('1'), expected: 'beta' })
    await run(new ScriptedLlm(() => verdict()))
    const text = renderReport(readSummary(home()))
    expect(text).toContain('预期命中 0/1')
    expect(text).toContain('alpha')
    expect(text).toContain('预期 beta')
  })
})

describe('command line', () => {
  it('without a command or with an unknown one, it prints usage and fails', async () => {
    for (const argv of [[], ['nope'], ['say'], ['replay'], ['project', 'add']]) {
      const { io, errors } = capture()
      await expect(main(argv, io, home())).resolves.toBe(1)
      expect(errors.join('')).toContain('用法')
    }
  })

  it('when projects are added and listed, they appear with their paths', async () => {
    const { io, lines } = capture()
    await main(['project', 'add', 'alpha', home().home, '--brief', 'b'], io, home())
    await main(['project', 'list'], io, home())
    expect(lines.at(-1)).toBe(`alpha\t影子\t${home().home}`)
  })

  it('when a request is said, it waits in the spool under the id it prints', async () => {
    const { io, lines } = capture()
    await main(['say', 'hello', 'there', '--thread', 'th'], io, home())
    expect(lines[0]).toMatch(/^cli:/)
    expect(readFileSync(join(home().spool, readdirSync(home().spool)[0] ?? ''), 'utf8')).toContain('hello there')
  })

  it('when a replay file is valid, every line is handed over with its expected answer', async () => {
    const file = join(home().home, 'r.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{"id":"a","text":"one","expected":"alpha"}\r\n{"id":"b","text":"two","thread":"x"}\n')
    const { io, lines } = capture()
    await main(['replay', file], io, home())
    expect(lines[0]).toContain('2')
    expect(readdirSync(home().spool).filter((name) => name.endsWith('.json'))).toHaveLength(2)
  })

  it('when one replay line is invalid, nothing is handed over', async () => {
    const file = join(home().home, 'r.jsonl')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    writeFileSync(file, '{"id":"a","text":"one"}\n{"id":"b"}\n')
    mkdirSync(home().spool, { recursive: true })
    await expect(main(['replay', file], capture().io, home())).rejects.toThrow()
    expect(readdirSync(home().spool)).toEqual([])
  })

  it('with no database yet, status, decisions and report still answer', async () => {
    const { io, lines } = capture()
    await expect(main(['status'], io, home())).resolves.toBe(0)
    await expect(main(['status', '--json'], io, home())).resolves.toBe(0)
    await expect(main(['decisions'], io, home())).resolves.toBe(0)
    await expect(main(['report'], io, home())).resolves.toBe(0)
    await expect(main(['report', '--json'], io, home())).resolves.toBe(0)
    expect(lines[0]).toContain('待接收 0')
    expect(lines[2]).toBe('[]')
  })

  it('when a decision is reviewed, the latest review shows in the report', async () => {
    addProject(home().projects, { id: 'alpha', path: home().home, brief: '' })
    writeSpool(home(), request('1'))
    await run(new ScriptedLlm(() => verdict()))
    const { io } = capture()
    await expect(main(['review', 'cli:1', 'wrong', '--note', 'n'], io, home())).resolves.toBe(0)
    await main(['review', 'cli:1', 'ok'], io, home())
    expect(readSummary(home()).summary).toMatchObject({ reviewedOk: 1, reviewedWrong: 0 })
  })

  it('when a review names an unknown request or verdict, it is refused', async () => {
    const { io, errors } = capture()
    await expect(main(['review', 'cli:missing', 'ok'], io, home())).resolves.toBe(1)
    expect(errors[0]).toContain('cli:missing')
    await expect(main(['review', 'cli:1', 'maybe'], io, home())).resolves.toBe(1)
  })
})

describe('process boundary', () => {
  const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const sources = (readdirSync(sourceDir, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name: name.replaceAll('\\', '/'), text: readFileSync(join(sourceDir, name), 'utf8') }))

  it('only a Leader call, a manager turn and the omh client may start a process', () => {
    const spawning = sources.filter((file) => file.text.includes('node:child_process')).map((file) => file.name)
    expect(spawning.sort()).toEqual(['llm/claude-cli.ts', 'manager/omh.ts', 'manager/turn.ts'])
  })
})
