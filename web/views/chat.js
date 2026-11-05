import { el, emptyState, replace } from '../dom.js'
import { formatTime, threadName, userStateText } from '../format.js'

const MAX_TEXT_CHARS = 20_000
const BOTTOM_THRESHOLD_PX = 8

function sameKey(element, key) {
  return element instanceof HTMLElement && element.dataset.thread === key
}

export function createChatView(documentRoot, handlers) {
  const threadPanel = documentRoot.querySelector('#thread-panel')
  const conversationPanel = documentRoot.querySelector('#conversation-panel')
  const threadList = el('div', { className: 'panel-scroll thread-list' })
  const newThread = el('button', { text: '+ 新话题', attrs: { type: 'button' } })
  const messageArea = el('div', { className: 'message-list', attrs: { 'aria-live': 'polite' } })
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

  replace(threadPanel, el('div', { className: 'panel-title' }, [el('h2', { text: '话题' }), newThread]), threadList)
  replace(
    conversationPanel,
    el('div', { className: 'conversation-heading' }, [el('h2', { text: '对话' })]),
    messageArea,
    composer,
  )

  let sending = false

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
    return el(
      'article',
      {
        className: `message message-${message.role}`,
        attrs: { 'data-message-id': message.id },
      },
      [header, el('div', { className: 'message-text', text: message.text })],
    )
  }

  function renderThreads(threads, activeKey) {
    const focusedThread = document.activeElement?.dataset?.thread
    if (!threads.length) replace(threadList, emptyState('还没有话题。点“新话题”给 Leader 发第一条消息。'))
    else replace(threadList, ...threads.map((thread) => threadButton(thread, activeKey)))
    if (focusedThread) {
      for (const row of threadList.querySelectorAll('[data-thread]')) {
        if (sameKey(row, focusedThread)) row.focus()
      }
    }
  }

  function renderMessages(messages, activeKey) {
    const wasAtBottom =
      messageArea.scrollHeight - messageArea.scrollTop - messageArea.clientHeight <= BOTTOM_THRESHOLD_PX
    const previousTop = messageArea.scrollTop
    if (!activeKey) replace(messageArea, emptyState('选择左边的话题，或新建一个话题。'))
    else if (!messages.length) replace(messageArea, emptyState('这个话题还没有消息。'))
    else replace(messageArea, ...messages.map(messageNode))
    if (wasAtBottom) messageArea.scrollTop = messageArea.scrollHeight
    else messageArea.scrollTop = previousTop
  }

  function syncComposer(activeKey) {
    const isReplay = activeKey?.startsWith('replay:')
    textarea.disabled = Boolean(isReplay)
    sendButton.disabled = Boolean(isReplay) || sending
    readonly.hidden = !isReplay
    textarea.placeholder = activeKey ? '继续这个话题…' : '新话题：写给 Leader 的第一条消息…'
  }

  function update({ threads = [], activeKey = null, messages = [] } = {}) {
    renderThreads(threads, activeKey)
    renderMessages(messages, activeKey)
    syncComposer(activeKey)
  }

  function setCount() {
    count.textContent = `${textarea.value.length} / ${MAX_TEXT_CHARS}`
  }

  function showError(message) {
    error.hidden = false
    error.textContent = message
  }

  function clearError() {
    error.hidden = true
    error.textContent = ''
  }

  async function submit() {
    if (sending || textarea.disabled) return
    const text = textarea.value
    clearError()
    if (!text.trim()) {
      showError('消息不能为空。')
      return
    }
    if (text.length > MAX_TEXT_CHARS) {
      showError(`消息最多 ${MAX_TEXT_CHARS} 字。`)
      return
    }
    sending = true
    sendButton.disabled = true
    try {
      await handlers.onSend(text)
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : '发送失败，请重试。')
    } finally {
      sending = false
      syncComposer(handlers.activeKey())
    }
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    void submit()
  })
  textarea.addEventListener('input', () => {
    setCount()
    clearError()
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault()
      void submit()
    }
  })
  threadList.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-thread]') : null
    if (row instanceof HTMLElement && row.dataset.thread) handlers.onSelectThread(row.dataset.thread)
  })
  newThread.addEventListener('click', () => handlers.onNewThread())

  return {
    threadPanel,
    conversationPanel,
    update,
    showError,
    clearError,
    clearComposer() {
      textarea.value = ''
      setCount()
      clearError()
    },
    focusComposer() {
      textarea.focus()
    },
  }
}
