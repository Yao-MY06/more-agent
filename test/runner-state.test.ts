import { check } from 'proper-lockfile'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCK_STALE_MS } from '../src/config.ts'
import { isRunnerUp } from '../src/runner-state.ts'
import { useHome } from './helpers.ts'

vi.mock('proper-lockfile', () => ({ check: vi.fn() }))

const home = useHome()
const checkMock = vi.mocked(check)

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('runner state', () => {
  beforeEach(() => {
    checkMock.mockReset()
  })

  it('returns false when the state directory does not exist', async () => {
    checkMock.mockRejectedValue(errno('ENOENT'))
    await expect(isRunnerUp(home())).resolves.toBe(false)
    expect(checkMock).toHaveBeenCalledWith(home().home, {
      lockfilePath: home().lock,
      stale: LOCK_STALE_MS,
    })
  })

  it('rethrows any error other than a missing state directory', async () => {
    const denied = errno('EACCES')
    checkMock.mockRejectedValue(denied)
    await expect(isRunnerUp(home())).rejects.toBe(denied)
  })
})
