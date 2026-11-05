const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

export function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : timeFormatter.format(date)
}

export function userStateText(state, outcome) {
  if (state === 'queued') return '排队中'
  if (state === 'received') return '等待判断'
  if (outcome === 'ignore') return 'Leader 判定不需要回复'
  return outcome ? `已判断：${outcome}` : '已判断'
}

export function stageText(stage) {
  return { ended: '已结束', person: '等你回答', working: '进行中', idle: '等工人' }[stage] ?? stage
}

export function formatCost(value) {
  return `$${Number(value || 0).toFixed(2)}`
}

export function threadName(key) {
  return String(key || '').replace(/^[^:]*:/, '')
}
