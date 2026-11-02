// Stands in for `omh`: the running jobs come from a file the test controls, and kills and moves are recorded beside it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const root = args[args.indexOf('--root') + 1]
const file = join(root, 'fake-omh-running.json')
const argAfter = (flag) => args[args.indexOf(flag) + 1]
const running = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).map((job) =>
      typeof job === 'string' ? { ticket: job, phase: 'build' } : job,
    )
  } catch {
    return []
  }
}
if (args.includes('status')) {
  console.log(JSON.stringify({ running: running() }))
} else if (args.includes('kill')) {
  const ticket = argAfter('kill')
  const phase = args.includes('--phase') ? argAfter('--phase') : 'build'
  writeFileSync(file, JSON.stringify(running().filter((job) => job.ticket !== ticket || job.phase !== phase)))
  writeFileSync(join(root, 'fake-omh-killed.txt'), `${ticket} ${phase}\n`, { flag: 'a' })
} else if (args.includes('move')) {
  if (existsSync(join(root, 'fake-omh-move-fails'))) {
    console.error('cannot move')
    process.exit(1)
  }
  const ticket = argAfter('move')
  writeFileSync(join(root, 'fake-omh-moved.txt'), `${ticket} ${argAfter(ticket)} ${argAfter('--reason')}\n`, {
    flag: 'a',
  })
}
