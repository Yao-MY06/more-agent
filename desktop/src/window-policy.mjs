/** URL policy for the shell: only the panel's exact origin may stay in this window. */
export function isPanelUrl(candidate, panelOrigin) {
  if (typeof candidate !== 'string' || typeof panelOrigin !== 'string') return false
  try {
    const target = new URL(candidate)
    const allowed = new URL(panelOrigin)
    return target.origin === allowed.origin && target.protocol === allowed.protocol
  } catch {
    return false
  }
}
