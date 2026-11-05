import { el, emptyState, replace } from '../dom.js'
import { formatCost, stageText } from '../format.js'

export function createTicketsView(documentRoot, handlers) {
  const panel = documentRoot.querySelector('#tickets-panel')
  const list = el('div', { className: 'panel-scroll ticket-list' })
  const error = el('div', { className: 'ticket-error', attrs: { role: 'alert' } })
  error.hidden = true
  replace(panel, el('div', { className: 'panel-title' }, [el('h2', { text: '工单' })]), error, list)
  const submitted = new Set()

  function showError(message) {
    error.hidden = false
    error.textContent = message
  }

  function clearError() {
    error.hidden = true
    error.textContent = ''
  }

  function questionBlock(ticket) {
    if (!ticket.question) return []
    return [
      el('div', { className: 'ticket-question' }, [
        el('strong', { text: '等你回答' }),
        el('p', { text: ticket.question }),
      ]),
    ]
  }

  function actions(ticket) {
    const buttons = []
    if (ticket.question && ticket.threadKey) {
      buttons.push(
        el('button', {
          text: '回答这个问题',
          attrs: { type: 'button', 'data-answer': ticket.id },
        }),
      )
    }
    if (ticket.stage !== 'ended') {
      buttons.push(
        el('button', {
          text: '停止',
          attrs: { type: 'button', 'data-stop': ticket.id },
        }),
      )
    }
    return buttons.length ? [el('div', { className: 'ticket-actions' }, buttons)] : []
  }

  function ticketCard(ticket, project) {
    const ended = ticket.stage === 'ended'
    const stage = ended && ticket.outcome ? `${stageText(ticket.stage)}（${ticket.outcome}）` : stageText(ticket.stage)
    const shadow = project ? !project.execute : false
    const status = submitted.has(ticket.id)
      ? [el('div', { className: 'ticket-submitted', text: '已提交停止，等待 runner 处理。' })]
      : []
    return el(
      'article',
      {
        className: `ticket-card stage-${ticket.stage}`,
        attrs: { 'data-ticket': ticket.id },
      },
      [
        el('div', { className: 'ticket-card-header' }, [
          el('h3', { text: ticket.title }),
          el('span', { className: 'ticket-stage', text: stage }),
        ]),
        el('div', { className: 'ticket-meta' }, [
          el('span', { text: ticket.project ?? '未分项目' }),
          shadow ? el('span', { className: 'shadow-label', text: '影子运行' }) : null,
          el('span', { text: `${ticket.turns} 轮 · ${formatCost(ticket.costUsd)}` }),
        ]),
        shadow ? el('p', { className: 'ticket-note', text: '这是影子运行：不会派出工人，也不会发出工单回复。' }) : null,
        ...questionBlock(ticket),
        ...status,
        ...actions(ticket),
      ],
    )
  }

  function bindActions() {
    for (const button of list.querySelectorAll('[data-answer]')) {
      button.addEventListener('click', () => {
        handlers.onAnswer(button.dataset.answer).catch((failure) => {
          showError(failure instanceof Error ? failure.message : '打开话题失败，请重试。')
        })
      })
    }
    for (const button of list.querySelectorAll('[data-stop]')) {
      button.addEventListener('click', () => {
        const card = list.querySelector(`[data-ticket="${button.dataset.stop}"]`)
        const title = card?.querySelector('h3')?.textContent ?? button.dataset.stop
        if (!window.confirm(`确定停止“${title}”吗？runner 会连同经理和工人一起停止，真正停下要等它处理。`)) return
        clearError()
        handlers.onStop(button.dataset.stop).catch((failure) => {
          showError(failure instanceof Error ? failure.message : '停止失败，请重试。')
        })
      })
    }
  }

  function update(tickets = [], projects = []) {
    const byId = new Map(projects.map((project) => [project.id, project]))
    if (!tickets.length) replace(list, emptyState('还没有工单。Leader 接下的工作会出现在这里。'))
    else replace(list, ...tickets.map((ticket) => ticketCard(ticket, byId.get(ticket.project))))
    bindActions()
  }

  function markSubmitted(id) {
    submitted.add(id)
    for (const card of list.querySelectorAll('[data-ticket]')) {
      if (card.dataset.ticket !== id || card.querySelector('.ticket-submitted')) continue
      card.append(el('div', { className: 'ticket-submitted', text: '已提交停止，等待 runner 处理。' }))
    }
  }

  return { panel, update, markSubmitted, showError }
}
