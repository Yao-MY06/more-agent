import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { leaderSettings, type ManagerSettings } from '../src/config.ts'
import { ClaudeCli } from '../src/llm/claude-cli.ts'
import { addProject } from '../src/projects.ts'
import { Runtime } from '../src/runtime.ts'
import { readTickets } from '../src/tickets-view.ts'
import { startWebServer, type WebServer } from '../src/web/server.ts'
import { Store } from '../vendor/dsh-superagent/src/app/store.ts'
import { BROWSER_PATH, type BrowserSession, launchBrowser } from './browser-helpers.ts'
import { useHome } from './helpers.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const FAKE_LEADER = join(FIXTURES, 'fake-claude.mjs')
const FAKE_MANAGER = join(FIXTURES, 'fake-manager.mjs')
const FAKE_OMH = join(FIXTURES, 'fake-omh.mjs')
const SKILL = join(FIXTURES, 'skill.md')
const home = useHome()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let web: WebServer | undefined
let browser: BrowserSession | undefined

afterEach(async () => {
  await browser?.close()
  browser = undefined
  await web?.close()
  web = undefined
  vi.unstubAllEnvs()
}, 30_000)

function manager(): ManagerSettings {
  return {
    model: 'fake-manager',
    effort: 'low',
    command: [process.execPath, FAKE_MANAGER],
    turnBudgetUsd: 1,
    omh: FAKE_OMH,
    skill: SKILL,
  }
}

async function setupRun(script: unknown[]) {
  const paths = home()
  const project = join(paths.home, 'project')
  mkdirSync(join(project, '.omh'), { recursive: true })
  writeFileSync(join(project, '.omh', 'config.json'), '{}')
  addProject(paths.projects, { id: 'demo', path: project, brief: 'Demo', execute: true })
  const managerScript = join(paths.home, 'manager-script.json')
  writeFileSync(managerScript, JSON.stringify(script))
  vi.stubEnv('FAKE_MANAGER_SCRIPT', managerScript)
  vi.stubEnv('FAKE_MANAGER_LOG', join(paths.home, 'manager.log'))
  vi.stubEnv('FAKE_CLAUDE_LOG', join(paths.home, 'leader.log'))
  const llm = new ClaudeCli(
    leaderSettings({
      ...process.env,
      RESIDENT_LEADER_COMMAND: JSON.stringify([process.execPath, FAKE_LEADER]),
    }),
    paths.leaderCwd,
  )
  const opened = await Runtime.open({
    paths,
    llm,
    manager: manager(),
    onLockLost: (error) => {
      throw error
    },
  })
  return { paths, ...opened }
}

async function send(browserSession: BrowserSession, text: string): Promise<void> {
  await browserSession.setValue('.composer-input', text)
  await browserSession.click('[data-send]')
  await browserSession.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`)
}

describe.runIf(BROWSER_PATH)('tickets in a real browser', () => {
  it('shows a manager question, answers in its thread, and shows the completed result', async () => {
    const { paths, runtime, release } = await setupRun([
      { report: { state: 'blocked', summary: '两种做法都行', question: '用 A 还是 B？' } },
      { report: { state: 'ready', summary: '用 A 做完了' }, takeUp: 'taken_up' },
    ])
    try {
      web = await startWebServer({ paths, port: 0 })
      browser = await launchBrowser(web.url)
      await browser.waitFor("document.querySelector('#runner-indicator')?.textContent.includes('运行中')")
      await send(browser, '做这个')
      await browser.waitFor("document.body.innerText.includes('排队中')")

      await runtime.runUntilIdle(undefined, 20_000)
      await browser.waitFor("document.body.innerText.includes('用 A 还是 B？')", 15_000)
      expect(await browser.evaluate("document.body.innerText.includes('影子运行')")).toBe(false)
      expect(await browser.evaluate("document.querySelector('.ticket-question')?.textContent")).toContain(
        '用 A 还是 B？',
      )

      await browser.click('[data-answer]')
      await browser.waitFor("document.activeElement?.classList.contains('composer-input')")
      await send(browser, '用 A')
      await browser.waitFor("document.body.innerText.includes('排队中')")

      await runtime.runUntilIdle(undefined, 20_000)
      await browser.waitFor("document.body.innerText.includes('已结束（completed）')", 15_000)
      await browser.waitFor("document.body.innerText.includes('用 A 做完了')", 15_000)
      expect(browser.errors).toEqual([])
    } finally {
      await runtime.close()
      await release()
    }
  }, 90_000)

  it('confirms a stop, shows it was submitted, and then shows the ticket stopped', async () => {
    const { paths, runtime, release } = await setupRun([
      { report: { state: 'ready', summary: '不该完成' }, delayMs: 60_000 },
    ])
    try {
      web = await startWebServer({ paths, port: 0 })
      browser = await launchBrowser(web.url)
      await browser.waitFor("document.querySelector('#runner-indicator')?.textContent.includes('运行中')")
      await send(browser, '做一个会停下的任务')
      await browser.waitFor("document.body.innerText.includes('排队中')")

      const started = Date.now()
      while (!readTickets(paths).length && Date.now() - started < 15_000) {
        runtime.tick()
        await sleep(50)
      }
      expect(readTickets(paths)).toHaveLength(1)
      await browser.waitFor("!!document.querySelector('[data-stop]')", 10_000)

      await browser.evaluate('window.confirm = () => true')
      await browser.click('[data-stop]')
      await browser.waitFor("document.body.innerText.includes('已提交停止')")
      await runtime.runUntilIdle(undefined, 20_000)
      await browser.waitFor("document.body.innerText.includes('已结束（stopped）')", 15_000)
    } finally {
      await runtime.close()
      await release()
    }
  }, 90_000)

  it('marks a shadow project ticket without waiting for a worker', async () => {
    const paths = home()
    addProject(paths.projects, { id: 'demo', path: paths.home, brief: '', execute: false })
    const store = new Store(paths.db)
    try {
      const at = '2026-11-04T00:00:00.000Z'
      const decision = {
        id: 'd1',
        evalId: 'e1',
        threadKey: 'cli:work',
        triggerIds: ['cli:m1'],
        policyVersion: '1',
        at,
        kind: 'accept',
        reason: [],
        strength: 'explicit',
        audit: { project: 'demo' },
      }
      const ticket = {
        id: 'shadow-ticket',
        title: '影子工单',
        decisionId: 'd1',
        mandate: { scope: '演示' },
        channels: [{ source: 'cli', thread: 'cli:work', address: {} }],
        assignments: [],
        inputs: [],
        undelivered: [],
        createdAt: at,
        updatedAt: at,
        origin: { triggerId: 'cli:m1', triggerIds: ['cli:m1'] },
      }
      store.db
        .prepare('INSERT INTO decision (id, thread, value) VALUES (?, ?, ?)')
        .run('d1', 'cli:work', JSON.stringify(decision))
      store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('shadow-ticket', JSON.stringify(ticket))
    } finally {
      store.close()
    }
    web = await startWebServer({ paths, port: 0 })
    browser = await launchBrowser(web.url)
    await browser.waitFor("document.body.innerText.includes('影子运行')")
    expect(await browser.evaluate("document.body.innerText.includes('不会派出工人')")).toBe(true)
  }, 60_000)
})
