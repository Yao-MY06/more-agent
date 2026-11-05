import { check } from 'proper-lockfile'
import { LOCK_STALE_MS, type Paths } from './config.ts'

/** 和 Runtime.open 用同样的锁参数。状态目录还不存在时算没有运行。 */
export async function isRunnerUp(paths: Paths): Promise<boolean> {
  try {
    return await check(paths.home, { lockfilePath: paths.lock, stale: LOCK_STALE_MS })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
