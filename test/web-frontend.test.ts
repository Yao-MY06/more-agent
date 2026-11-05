import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectRoot } from '../src/config.ts'
import { startWebServer, type WebServer } from '../src/web/server.ts'
import { BROWSER_PATH, type BrowserSession, launchBrowser } from './browser-helpers.ts'
import { useHome } from './helpers.ts'
import { request } from './web-helpers.ts'

const WEB_ROOT = join(projectRoot(), 'web')
const home = useHome()
let web: WebServer | undefined
let browser: BrowserSession | undefined

afterEach(async () => {
  await browser?.close()
  browser = undefined
  await web?.close()
  web = undefined
}, 30_000)

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = join(directory, name)
    return statSync(file).isDirectory() ? filesUnder(file) : [file]
  })
}

describe('web frontend files', () => {
  it('serves every local module and stylesheet with safe MIME and cache headers', async () => {
    web = await startWebServer({ paths: home(), port: 0 })
    const expected = new Map([
      ['/', 'text/html'],
      ['/favicon.png', 'image/png'],
      ['/style.css', 'text/css'],
      ['/app.js', 'text/javascript'],
      ['/api.js', 'text/javascript'],
      ['/dom.js', 'text/javascript'],
      ['/format.js', 'text/javascript'],
      ['/views/chat.js', 'text/javascript'],
      ['/views/tickets.js', 'text/javascript'],
      ['/views/memory.js', 'text/javascript'],
      ['/views/status.js', 'text/javascript'],
    ])
    for (const [path, type] of expected) {
      const response = await request(web, { path })
      expect(response.status, path).toBe(200)
      expect(response.headers['content-type'], path).toContain(type)
      expect(response.headers['cache-control'], path).toBe('no-cache')
      expect(response.headers['content-security-policy'], path).toContain("default-src 'none'")
      expect(response.body.length, path).toBeGreaterThan(0)
    }
  })

  it('uses no HTML parsing, eval, inline handlers or external resources', () => {
    const files = filesUnder(WEB_ROOT)
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    const dangerous = [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /javascript:/i,
      /\bon[a-z]+\s*=/i,
      /https?:\/\//i,
    ]
    for (const pattern of dangerous) expect(text, `forbidden pattern ${pattern}`).not.toMatch(pattern)
    expect(files.map((file) => relative(WEB_ROOT, file).replaceAll('\\', '/'))).toEqual(
      expect.arrayContaining([
        'index.html',
        'favicon.png',
        'style.css',
        'app.js',
        'api.js',
        'dom.js',
        'format.js',
        'views/chat.js',
        'views/tickets.js',
        'views/memory.js',
        'views/status.js',
      ]),
    )
  })

  it.runIf(BROWSER_PATH)(
    'loads in a real browser with CSP active, no console errors and the empty views visible',
    async () => {
      web = await startWebServer({ paths: home(), port: 0 })
      browser = await launchBrowser(web.url)
      await browser.waitFor("document.body.innerText.includes('runner 没运行')")
      await browser.waitFor("document.body.innerText.includes('还没有话题')")
      await browser.waitFor("document.body.innerText.includes('还没有工单')")
      expect(await browser.evaluate("getComputedStyle(document.querySelector('#memory-panel')).display")).toBe('none')
      await browser.click('[data-view="memory"]')
      await browser.waitFor("getComputedStyle(document.querySelector('#memory-panel')).display !== 'none'")
      await browser.waitFor("document.body.innerText.includes('还没有记忆')")
      expect(await browser.evaluate("document.querySelector('#mobile-panel-nav').hidden")).toBe(true)
      expect(browser.errors).toEqual([])
    },
    60_000,
  )
})
