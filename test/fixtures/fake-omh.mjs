// Stands in for `omh`: the running tickets come from a file the test controls, and kills are recorded there.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const root = args[args.indexOf('--root') + 1]
const file = join(root, 'fake-omh-running.json')
const running = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}
if (args.includes('status')) {
  console.log(JSON.stringify({ running: running().map((ticket) => ({ ticket })) }))
} else if (args.includes('kill')) {
  const ticket = args[args.indexOf('kill') + 1]
  writeFileSync(file, JSON.stringify(running().filter((item) => item !== ticket)))
  writeFileSync(join(root, 'fake-omh-killed.txt'), `${ticket}\n`, { flag: 'a' })
}
