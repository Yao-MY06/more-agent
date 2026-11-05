import { describe, expect, it } from 'vitest'
import { isPanelUrl } from '../desktop/src/window-policy.mjs'

const PANEL_ORIGIN = 'http://127.0.0.1:53124'

describe('window URL policy', () => {
  it('allows the panel origin on any path, query, or fragment', () => {
    expect(isPanelUrl(`${PANEL_ORIGIN}/`, PANEL_ORIGIN)).toBe(true)
    expect(isPanelUrl(`${PANEL_ORIGIN}/api/overview?x=1#token=abc`, PANEL_ORIGIN)).toBe(true)
    expect(isPanelUrl('HTTP://127.0.0.1:53124/', PANEL_ORIGIN)).toBe(true)
  })

  it('rejects lookalike hosts, credentials, schemes, and other ports', () => {
    for (const candidate of [
      'http://127.0.0.1:1@evil.example/',
      'http://127.0.0.1.evil.example/',
      'http://127.0.0.1:53125/',
      'https://127.0.0.1:53124/',
      'http://localhost:53124/',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isPanelUrl(candidate, PANEL_ORIGIN), candidate).toBe(false)
    }
  })

  it('rejects invalid panel origins and non-string candidates', () => {
    expect(isPanelUrl('http://127.0.0.1:53124/', 'not an origin')).toBe(false)
    expect(isPanelUrl(undefined, PANEL_ORIGIN)).toBe(false)
    expect(isPanelUrl(null, PANEL_ORIGIN)).toBe(false)
  })
})
