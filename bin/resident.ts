import { main } from '../src/cli.ts'

main(process.argv.slice(2), { out: console.log, err: console.error }).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  },
)
