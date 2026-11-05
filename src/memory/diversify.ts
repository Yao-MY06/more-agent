/**
 * Carbonell and Goldstein's maximal marginal relevance, after OpenClaw's memory-core (MIT): a card has few places, and five reports
 * of the same chore would otherwise fill them all and push out the one record that holds a decision.
 */
import { memoryTokens } from './tokens.ts'

/** OpenClaw's default: relevance leads, and repetition only breaks what is close. */
const RELEVANCE_WEIGHT = 0.7
/**
 * More alike than this and a record says nothing the chosen one did not, so it waits until all others had their turn. The weight
 * alone cannot do this: it costs a copy at most 0.3, and the weakest match counts as 0, so ten copies would still beat it.
 */
const NEAR_COPY = 0.8

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}

/** @param items best first. @returns up to `limit` of them, each chosen for its score less its likeness to those before it. */
export function diversify<T extends { score: number; body: string }>(items: readonly T[], limit: number): T[] {
  const top = items[0]?.score ?? 0
  const bottom = items.at(-1)?.score ?? 0
  const range = top - bottom
  const remaining = items.map((item) => ({
    item,
    relevance: range ? (item.score - bottom) / range : 1,
    tokens: new Set(memoryTokens(item.body)),
    likeness: 0,
  }))
  const chosen: T[] = []
  while (remaining.length && chosen.length < limit) {
    const value = (entry: (typeof remaining)[number]) =>
      entry.likeness >= NEAR_COPY
        ? Number.NEGATIVE_INFINITY
        : RELEVANCE_WEIGHT * entry.relevance - (1 - RELEVANCE_WEIGHT) * entry.likeness
    const best = remaining.reduce((winner, entry) => (value(entry) > value(winner) ? entry : winner))
    chosen.push(best.item)
    remaining.splice(remaining.indexOf(best), 1)
    for (const entry of remaining) entry.likeness = Math.max(entry.likeness, overlap(entry.tokens, best.tokens))
  }
  return chosen
}
