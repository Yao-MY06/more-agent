/** The Engine's clock. */

/**
 * Upstream decides whether a worker read a message before it reported by comparing timestamps strictly. A real worker's two
 * steps are seconds apart, but shadow execution does both within a millisecond, which would send the message back for a
 * second Eval. So no two readings are ever equal.
 */
export function monotonicClock(wall: () => number = Date.now): () => string {
  let last = Number.NEGATIVE_INFINITY
  return () => {
    last = Math.max(wall(), last + 1)
    return new Date(last).toISOString()
  }
}
