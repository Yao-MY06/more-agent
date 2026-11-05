import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { startWebServer, type WebServer } from '../src/web/server.ts'
import { BROWSER_PATH, type BrowserSession, launchBrowser } from './browser-helpers.ts'
import { useHome } from './helpers.ts'

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

function capture() {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) } }
}

function memoryText(paths: ReturnType<typeof home>): string {
  return readdirSync(paths.memory)
    .filter((name) => name.endsWith('.md'))
    .map((name) => readFileSync(join(paths.memory, name), 'utf8'))
    .join('\n')
}

describe.runIf(BROWSER_PATH)('memory in a real browser', () => {
  it('searches Chinese two-character words and keeps CLI and web writes visible to each other', async () => {
    const paths = home()
    await expect(main(['remember', '登录要记日志'], capture().io, paths)).resolves.toBe(0)
    web = await startWebServer({ paths, port: 0 })
    browser = await launchBrowser(web.url)
    await browser.waitFor("document.querySelector('#runner-indicator')?.textContent.includes('没运行')")

    await browser.click('[data-view="memory"]')
    await browser.waitFor("document.body.innerText.includes('登录要记日志')")
    await browser.waitFor("!!document.querySelector('[data-memory-id] [data-supersede]')")
    await browser.click('[data-memory-id] .memory-card-actions button')
    await browser.waitFor("document.querySelector('.memory-body')?.classList.contains('is-expanded')")
    await browser.setValue('.memory-tools input', '登录')
    await browser.click('[data-memory-search]')
    await browser.waitFor("document.body.innerText.includes('登录要记日志')")

    await browser.setValue('.memory-input', '网页新增的规则')
    await browser.click('[data-memory-save]')
    await browser.waitFor("document.body.innerText.includes('网页新增的规则')")
    const cli = capture()
    await main(['memory', 'search', '网页新增', '--json'], cli.io, paths)
    expect(JSON.parse(cli.lines.at(-1) ?? '[]')).toMatchObject([{ body: '网页新增的规则' }])

    const originalId = await browser.evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-memory-id]')].find((item) => item.textContent.includes('网页新增的规则'))
      return card?.dataset.memoryId
    })()`)
    await browser.evaluate(`document.querySelector('[data-memory-id="${originalId}"] [data-supersede]').click()`)
    await browser.setValue('.memory-input', '网页修订后的规则')
    await browser.click('[data-memory-save]')
    await browser.waitFor("document.body.innerText.includes('网页修订后的规则')")
    await browser.waitFor(`!document.querySelector('[data-memory-id="${originalId}"]')`)

    const replacementId = await browser.evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-memory-id]')].find((item) => item.textContent.includes('网页修订后的规则'))
      return card?.dataset.memoryId
    })()`)
    await browser.evaluate('window.confirm = () => true')
    await browser.evaluate(`document.querySelector('[data-memory-id="${replacementId}"] [data-forget]').click()`)
    await browser.waitFor("document.body.innerText.includes('已作废')")
    await browser.waitFor(`!document.querySelector('[data-memory-id="${replacementId}"]')`)
    const after = capture()
    await main(['memory', 'search', '网页修订', '--json'], after.io, paths)
    expect(JSON.parse(after.lines.at(-1) ?? '[]')).toEqual([])
    expect(memoryText(paths)).toContain('网页修订后的规则')
    expect(browser.errors).toEqual([])
  }, 60_000)
})
