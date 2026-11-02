// Stands in for a manager's `claude -p`: logs each turn, then plays the next step of a script file.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const { FAKE_MANAGER_SCRIPT: script, FAKE_MANAGER_LOG: log } = process.env
const counter = `${log}.count`
let stdin = ''
for await (const chunk of process.stdin) stdin += chunk
const turn = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
writeFileSync(counter, String(turn + 1))
appendFileSync(
  log,
  `${JSON.stringify({ turn, args: process.argv.slice(2), cwd: process.cwd(), stdin: JSON.parse(stdin), pid: process.pid })}\n`,
)

const steps = JSON.parse(readFileSync(script, 'utf8'))
const step = steps[Math.min(turn, steps.length - 1)]
await sleep(step.delayMs ?? 0)
if (step.stderr) console.error(step.stderr)
if (step.raw !== undefined) console.log(step.raw)
else if (step.report) {
  const report = { question: null, wait_for: [], followups: [], ...step.report }
  // A step can answer every message its card showed, as a real manager must.
  if (step.takeUp) {
    const shown = JSON.parse(stdin).inputs.filter((input) => input.kind === 'message')
    report.followups = shown.map((input) => ({
      trigger_id: input.trigger_id,
      decision: step.takeUp,
      text: `回应：${input.text}`,
    }))
  }
  console.log(
    JSON.stringify({
      type: 'result',
      is_error: false,
      structured_output: report,
      total_cost_usd: step.costUsd ?? 0.1,
      duration_ms: 5,
    }),
  )
}
process.exit(step.exit ?? 0)
