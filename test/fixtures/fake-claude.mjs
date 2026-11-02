// Stands in for `claude -p` in process-level tests: logs each call, waits, and routes to the first registered project.
import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

let input = ''
for await (const chunk of process.stdin) input += chunk
const card = JSON.parse(input)
appendFileSync(
  process.env.FAKE_CLAUDE_LOG,
  `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), card })}\n`,
)
await sleep(Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0))
const args = process.argv.slice(2)
const system = args[args.indexOf('--system-prompt') + 1]
const firstProject = system.match(/"id":"([^"]+)"/)[1]
const structured_output = {
  action: 'route',
  project: firstProject,
  title: 'Fake title',
  scope: card.request[0].text,
  reason: 'The fake routes everything.',
  acknowledgement: 'Fake acknowledgement.',
  question: null,
  confidence: 0.5,
}
console.log(
  JSON.stringify({ type: 'result', is_error: false, structured_output, total_cost_usd: 0.01, duration_ms: 5 }),
)
