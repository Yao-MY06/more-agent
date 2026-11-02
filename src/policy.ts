/** The deterministic gate for one person on one machine: only what they hand over themselves may start work. */
import type { Policy, SourceScope } from '../vendor/dsh-superagent/src/core/index.ts'
import { EVAL_TIMEOUT_MS } from './config.ts'
import { LOCAL_SOURCES } from './spool.ts'

const POLICY_VERSION = 'local-1'
const LISTENED: readonly string[] = LOCAL_SOURCES

export const localScope: SourceScope = {
  scope: ({ source }) =>
    LISTENED.includes(source) ? { listened: true, observed: false } : { listened: false, reason: 'unknownSource' },
}

export function localPolicy(): Policy {
  return {
    version: POLICY_VERSION,
    paused: false,
    evalTimeoutMs: EVAL_TIMEOUT_MS,
    gate: (trigger) =>
      trigger.human && trigger.addressed === 'direct'
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }
        : { admissible: false, reason: 'notDirect' },
    revalidate: () => true,
    // M0 starts no proactive work: nothing inferred is ever accepted.
    admitsInferred: () => false,
  }
}
