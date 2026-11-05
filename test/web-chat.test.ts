import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { leaderSettings, type ManagerSettings } from '../src/config.ts'
import { readInbox } from '../src/inbox.ts'
import { ClaudeCli } from '../src/llm/claude-cli.ts'
import { addProject } from '../src/projects.ts'
import { Runtime } from '../src/runtime.ts'
import { startWebServer, type WebServer } from '../src/web/server.ts'
import { BROWSER_PATH, type BrowserSession, launchBrowser } from './browser-helpers.ts'
import { useHome } from './helpers.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const FAKE = join(FIXTURES, 'fake-claude.mjs')
const home = useHome()
let web: WebServer | undefined
let browser: BrowserSession | undefined

afterEach(async () => {
  await browser?.close()
  browser = undefined
  await web?.close()
  web = undefined
  vi.unstubAllEnvs()
}, 30_000)

describe.runIf(BROWSER_PATH)('conversation in a real browser', () => {
  it('sends with Ctrl+Enter, shows queued then decided state, and receives the fake Leader reply', async () => {
    const paths = home()
    const project = join(paths.home, 'project')
    mkdirSync(project)
    mkdirSync(join(project, '.omh'))
    writeFileSync(join(project, '.omh', 'config.json'), '{}')
    addProject(paths.projects, { id: 'demo', path: project, brief: 'Demo', execute: true })
    const managerScript = join(paths.home, 'manager-script.json')
    writeFileSync(managerScript, JSON.stringify([{ report: { state: 'ready', summary: '浏览器流程完成' } }]))
    vi.stubEnv('FAKE_MANAGER_SCRIPT', managerScript)
    vi.stubEnv('FAKE_MANAGER_LOG', join(paths.home, 'manager.log'))
    const manager: ManagerSettings = {
      model: 'fake-manager',
      effort: 'low',
      command: [process.execPath, join(FIXTURES, 'fake-manager.mjs')],
      turnBudgetUsd: 1,
      omh: join(FIXTURES, 'fake-omh.mjs'),
      skill: join(FIXTURES, 'skill.md'),
    }
    vi.stubEnv('FAKE_CLAUDE_LOG', join(paths.home, 'calls.jsonl'))
    const llm = new ClaudeCli(
      leaderSettings({
        ...process.env,
        RESIDENT_LEADER_COMMAND: JSON.stringify([process.execPath, FAKE]),
      }),
      paths.leaderCwd,
    )
    const { runtime, release } = await Runtime.open({
      paths,
      llm,
      manager,
      onLockLost: (error) => {
        throw error
      },
    })
    try {
      web = await startWebServer({ paths, port: 0 })
      browser = await launchBrowser(web.url)
      await browser.waitFor("document.querySelector('#runner-indicator')?.textContent.includes('运行中')")
      await browser.setValue('.composer-input', '浏览器里给 demo 的请求')
      await browser.evaluate(`document.querySelector('.composer-input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
      )`)
      await browser.waitFor("document.body.innerText.includes('排队中')")
      expect(await browser.evaluate("document.querySelector('.composer-input').value")).toBe('')

      await runtime.runUntilIdle(undefined, 15_000)
      expect(readInbox(paths).entries.map((entry) => entry.text)).toContain('Fake acknowledgement.')
      await browser.waitFor("document.body.innerText.includes('Fake acknowledgement.')", 12_000)
      await browser.waitFor("document.body.innerText.includes('已判断：demo')", 12_000)
      expect(browser.errors).toEqual([])
    } finally {
      await runtime.close()
      await release()
    }
  }, 60_000)

  it('keeps the text and explains the limit when a send fails client-side', async () => {
    const paths = home()
    web = await startWebServer({ paths, port: 0 })
    browser = await launchBrowser(web.url)
    await browser.waitFor("document.querySelector('#runner-indicator')?.textContent.includes('没运行')")
    const text = 'x'.repeat(20_001)
    await browser.setValue('.composer-input', text)
    await browser.click('[data-send]')
    await browser.waitFor("!document.querySelector('.composer-error').hidden")
    expect(await browser.evaluate("document.querySelector('.composer-error').textContent")).toContain('20000')
    expect(await browser.evaluate("document.querySelector('.composer-input').value.length")).toBe(text.length)
  }, 40_000)
})
