// Stands in for a `claude -p` that fails, such as when the quota runs out.
process.stdin.resume()
process.stdin.on('end', () => {
  console.error('quota exhausted')
  process.exit(3)
})
