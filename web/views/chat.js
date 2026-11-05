import { el, emptyState, replace } from '../dom.js'
import { formatTime, threadName, userStateText } from '../format.js'

const MAX_TEXT_CHARS = 20_000
const BOTTOM_THRESHOLD_PX = 8

function sameKey(element, key) {
  return element instanceof HTMLElement && element.dataset.thread === key
}

function setCount(elements) {
  elements.count.textContent = `${elements.textarea.value.length} / ${MAX_TEXT_CHARS}`
}

function showError(elements, message) {
  elements.error.hidden = false
  elements.error.textContent = message
}

function clearError(elements) {
  elements.error.hidden = true
  elements.error.textContent = ''
}

function createComposer() {
  const textarea = el('textarea', {
    className: 'composer-input',
    attrs: {
      rows: '3',
      maxlength: String(MAX_TEXT_CHARS),
      placeholder: '写给 Leader 的消息…',
      'aria-label': '消息内容',
    },
  })
  const sendButton = el('button', {
    className: 'send-button',
    text: '发送',
    attrs: { type: 'submit', 'data-send': '' },
  })
  const count = el('span', { className: 'character-count', text: `0 / ${MAX_TEXT_CHARS}` })
  const error = el('div', { className: 'composer-error', attrs: { role: 'alert' } })
  const readonly = el('div', { className: 'composer-readonly', text: '回放话题只读，不能在这里发送。' })
  const composer = el('form', { className: 'composer' }, [
    textarea,
    el('div', { className: 'composer-actions' }, [
      el('span', { className: 'composer-hint', text: 'Ctrl+Enter 发送' }),
      count,
      sendButton,
    ]),
    error,
    readonly,
  ])
  error.hidden = true
  readonly.hidden = true
  return { textarea, sendButton, count, error, readonly, composer }
}

function createElements(documentRoot) {
  const threadPanel = documentRoot.querySelector('#thread-panel')
  const conversationPanel = documentRoot.querySelector('#conversation-panel')
  const threadList = el('div', { className: 'panel-scroll thread-list' })
  const newThread = el('button', { text: '+ 新话题', attrs: { type: 'button' } })
  const messageArea = el('div', { className: 'message-list', attrs: { 'aria-live': 'polite' } })
  const { textarea, sendButton, count, error, readonly, composer } = createComposer()
  replace(threadPanel, el('div', { className: 'panel-title' }, [el('h2', { text: '话题' }), newThread]), threadList)
  replace(
    conversationPanel,
    el('div', { className: 'conversation-heading' }, [el('h2', { text: '对话' })]),
    messageArea,
    composer,
  )
  return {
    threadPanel,
    conversationPanel,
    threadList,
    newThread,
    messageArea,
    textarea,
    sendButton,
    count,
    error,
    readonly,
    composer,
  }
}

function threadButton(thread, activeKey) {
  return el(
    'button',
    {
      className: `thread-row${thread.key === activeKey ? ' is-active' : ''}`,
      attrs: {
        type: 'button',
        'data-thread': thread.key,
        'aria-label': `打开话题 ${thread.preview || threadName(thread.key)}`,
      },
    },
    [
      el('span', { className: 'thread-preview', text: thread.preview || threadName(thread.key) }),
      el('span', { className: 'thread-meta', text: `${formatTime(thread.lastAt)} · ${thread.messageCount} 条` }),
    ],
  )
}

function messageNode(message) {
  const header = el('header', { className: 'message-header' }, [
    el('strong', { text: message.role === 'leader' ? 'Leader' : '你' }),
    el('time', { text: formatTime(message.at) }),
    message.role === 'user'
      ? el('span', {
          className: `message-state state-${message.state}`,
          text: userStateText(message.state, message.outcome),
        })
      : el('span', { className: 'message-state', text: message.kind === 'notice' ? '提醒' : '' }),
  ])
  return el('article', { className: `message message-${message.role}`, attrs: { 'data-message-id': message.id } }, [
    header,
    el('div', { className: 'message-text', text: message.text }),
  ])
}

function renderThreads(elements, threads, activeKey) {
  const focusedThread = document.activeElement?.dataset?.thread
  if (!threads.length) replace(elements.threadList, emptyState('还没有话题。点“新话题”给 Leader 发第一条消息。'))
  else replace(elements.threadList, ...threads.map((thread) => threadButton(thread, activeKey)))
  if (!focusedThread) return
  for (const row of elements.threadList.querySelectorAll('[data-thread]')) {
    if (sameKey(row, focusedThread)) row.focus()
  }
}

function renderMessages(elements, messages, activeKey) {
  const area = elements.messageArea
  const wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight <= BOTTOM_THRESHOLD_PX
  const previousTop = area.scrollTop
  if (!activeKey) replace(area, emptyState('选择左边的话题，或新建一个话题。'))
  else if (!messages.length) replace(area, emptyState('这个话题还没有消息。'))
  else replace(area, ...messages.map(messageNode))
  area.scrollTop = wasAtBottom ? area.scrollHeight : previousTop
}

function syncComposer(elements, activeKey, sending) {
  const isReplay = activeKey?.startsWith('replay:')
  elements.textarea.disabled = Boolean(isReplay)
  elements.sendButton.disabled = Boolean(isReplay) || sending
  elements.readonly.hidden = !isReplay
  elements.textarea.placeholder = activeKey ? '继续这个话题…' : '新话题：写给 Leader 的第一条消息…'
}

async function submitComposer(elements, handlers, state, sync) {
  if (state.sending || elements.textarea.disabled) return
  const text = elements.textarea.value
  clearError(elements)
  if (!text.trim()) {
    showError(elements, '消息不能为空。')
    return
  }
  if (text.length > MAX_TEXT_CHARS) {
    showError(elements, `消息最多 ${MAX_TEXT_CHARS} 字。`)
    return
  }
  state.sending = true
  elements.sendButton.disabled = true
  try {
    await handlers.onSend(text)
  } catch (failure) {
    showError(elements, failure instanceof Error ? failure.message : '发送失败，请重试。')
  } finally {
    state.sending = false
    sync()
  }
}

function bindEvents(elements, handlers, submit) {
  elements.composer.addEventListener('submit', (event) => {
    event.preventDefault()
    void submit()
  })
  elements.textarea.addEventListener('input', () => {
    setCount(elements)
    clearError(elements)
  })
  elements.textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault()
      void submit()
    }
  })
  elements.threadList.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-thread]') : null
    if (row instanceof HTMLElement && row.dataset.thread) handlers.onSelectThread(row.dataset.thread)
  })
  elements.newThread.addEventListener('click', () => handlers.onNewThread())
}

function clearComposer(elements) {
  elements.textarea.value = ''
  setCount(elements)
  clearError(elements)
}

export function createChatView(documentRoot, handlers) {
  const elements = createElements(documentRoot)
  const state = { sending: false }
  const sync = () => syncComposer(elements, handlers.activeKey(), state.sending)
  const submit = () => submitComposer(elements, handlers, state, sync)
  bindEvents(elements, handlers, submit)
  return {
    threadPanel: elements.threadPanel,
    conversationPanel: elements.conversationPanel,
    update({ threads = [], activeKey = null, messages = [] } = {}) {
      renderThreads(elements, threads, activeKey)
      renderMessages(elements, messages, activeKey)
      syncComposer(elements, activeKey, state.sending)
    },
    showError: (message) => showError(elements, message),
    clearError: () => clearError(elements),
    clearComposer: () => clearComposer(elements),
    focusComposer: () => elements.textarea.focus(),
  }
}
