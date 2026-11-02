/** The runner's own calls to `omh`, always asynchronous: a slow call must not hold up the runner's lock heartbeat. */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { OMH_CALL_TIMEOUT_MS } from '../config.ts'

const StatusSchema = z.looseObject({
  running: z.array(z.looseObject({ ticket: z.string(), phase: z.string() })),
})
type RunningJob = z.infer<typeof StatusSchema>['running'][number]

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

async function runningJobs(omh: string, root: string): Promise<RunningJob[]> {
  return StatusSchema.parse(JSON.parse(await callOmh(omh, root, ['status', '--json']))).running
}

/** The `omh` tickets with a job running in this project. @throws when `omh` fails or answers something unreadable. */
export async function runningTickets(omh: string, root: string): Promise<string[]> {
  return [...new Set((await runningJobs(omh, root)).map((job) => job.ticket))]
}

/** `omh` keeps a ticket's state as the folder its file is in. */
function isInDoing(root: string, ticket: string): boolean {
  const doing = join(root, '_tickets', 'doing')
  return existsSync(doing) && readdirSync(doing).some((name) => name.startsWith(`${ticket}-`))
}

async function attempt(failed: string[], ticket: string, work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch (error) {
    failed.push(`${ticket}: ${String(error)}`)
  }
}

/**
 * Ends every job running in this project, each by its own phase since a plain `omh kill` only reaches a build, and moves their
 * tickets out of `doing`, where no one would ever pick them up again. A ticket already accepted while its review ran stays put.
 * @returns the tickets it could not stop or move, each with why.
 * @throws when `omh` cannot say what is running.
 */
export async function killWorkers(omh: string, root: string, reason: string): Promise<string[]> {
  const jobs = await runningJobs(omh, root)
  const failed: string[] = []
  for (const { ticket, phase } of jobs)
    await attempt(failed, ticket, callOmh(omh, root, ['kill', ticket, '--phase', phase]))
  for (const ticket of new Set(jobs.map((job) => job.ticket))) {
    if (!isInDoing(root, ticket)) continue
    await attempt(failed, ticket, callOmh(omh, root, ['move', ticket, 'blocked', '--reason', reason]))
  }
  return failed
}
