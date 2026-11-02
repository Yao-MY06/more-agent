import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'dsh-superagent')
const manifest = JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf8')) as {
  commit: string
  unchanged: Record<string, string>
  modified: string[]
}

describe('vendored upstream code', () => {
  it('records the commit it was copied from and its MIT license', () => {
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(readFileSync(join(VENDOR, 'LICENSE'), 'utf8')).toContain('MIT License')
  })
  it('when a file is listed as unchanged, its content still matches upstream', () => {
    const drifted = Object.entries(manifest.unchanged).filter(([file, hash]) => {
      const text = readFileSync(join(VENDOR, file), 'utf8').replace(/\r\n/g, '\n')
      return createHash('sha256').update(text).digest('hex') !== hash
    })
    expect(drifted.map(([file]) => file)).toEqual([])
  })
  it('keeps the upstream engine itself unmodified', () => {
    expect(manifest.modified.filter((file) => file.startsWith('src/core/'))).toEqual([])
    expect(Object.keys(manifest.unchanged)).toContain('src/core/engine.ts')
  })
})
