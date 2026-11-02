// A command for turn-process tests. The mode names what it does.
import { spawn } from 'node:child_process'

const LONG_MS = 120_000
const mode = process.argv[2]

if (mode === 'echo') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  process.stdout.write(input)
} else if (mode === 'fail') {
  console.error('it broke')
  process.exit(3)
} else if (mode === 'sleep') {
  setTimeout(() => {}, LONG_MS)
} else if (mode === 'sleep-with-child') {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${LONG_MS})`], { stdio: 'ignore' })
  console.log(`child=${child.pid}`)
  setTimeout(() => {}, LONG_MS)
}
