/** The runner's own calls to `omh`, always asynchronous: a slow call must not hold up the runner's lock heartbeat. */
import { execFile } from 'node:child_process'
import { z } from 'zod'
import { OMH_CALL_TIMEOUT_MS } from '../config.ts'

const StatusSchema = z.looseObject({
  running: z.array(z.looseObject({ ticket: z.string() })),
})

function callOmh(omh: string, root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [omh, '--root', root, ...args],
      { cwd: root, timeout: OMH_CALL_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

/** The `omh` tickets with a job running in this project. @throws when `omh` fails or answers something unreadable. */
export async function runningTickets(omh: string, root: string): Promise<string[]> {
  const status = StatusSchema.parse(JSON.parse(await callOmh(omh, root, ['status', '--json'])))
  return [...new Set(status.running.map((job) => job.ticket))]
}

/** Ends every worker running in this project. @returns the tickets it could not stop, each with why. */
export async function killWorkers(omh: string, root: string): Promise<string[]> {
  const failed: string[] = []
  for (const ticket of await runningTickets(omh, root)) {
    try {
      await callOmh(omh, root, ['kill', ticket])
    } catch (error) {
      failed.push(`${ticket}: ${String(error)}`)
    }
  }
  return failed
}
