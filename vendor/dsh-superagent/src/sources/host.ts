/** more-agent: only the Health type of upstream's Source host, which `infra/health.ts` reports. */
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; values?: Record<string, string> }
