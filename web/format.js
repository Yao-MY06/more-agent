const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const OUTCOME_TEXT = {
  clarify: '需要澄清',
  answer: 'Leader 已直接回答',
  remember: '已记下',
  recall: '已查记忆',
  attach: '已并入进行中的工单',
  unavailable: 'Leader 暂时无法判断',
  route: '已交给项目',
  accept: '已交给项目',
  ignore: 'Leader 判定不需要回复',
}

export function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : timeFormatter.format(date)
}

export function userStateText(state, outcome) {
  if (state === 'queued') return '排队中'
  if (state === 'received') return '等待判断'
  if (!outcome) return '已判断'
  if (Object.hasOwn(OUTCOME_TEXT, outcome)) return OUTCOME_TEXT[outcome]
  return `已交给项目：${outcome}`
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
