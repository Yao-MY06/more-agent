import { ApiError, createApi } from './api.js'
import { createChatView } from './views/chat.js'
import { createMemoryView } from './views/memory.js'
import { createStatusView } from './views/status.js'
import { createTicketsView } from './views/tickets.js'

const POLL_MS = 3000
const MAX_BACKOFF_MS = 30_000
const TOKEN_KEY = 'resident-web-token'

function tokenFromPage() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  const fromHash = params.get('token')
  if (fromHash) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromHash)
    } catch {}
    history.replaceState(null, '', `${location.pathname}${location.search}`)
    return fromHash
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

const token = tokenFromPage()
const api = token ? createApi(token) : null
const status = createStatusView(document)
const workspace = document.querySelector('#workspace')
const mobilePanelNav = document.querySelector('#mobile-panel-nav')
let failures = 0
let timer
let polling = false
let stopped = false
let threads = []
let activeKey = null
let messages = []
let draftMode = false
let currentOverview = null
let currentTickets = []

const chat = createChatView(document, {
  activeKey: () => activeKey,
  onNewThread() {
    draftMode = true
    activeKey = null
    messages = []
    chat.update({ threads, activeKey, messages })
    chat.focusComposer()
  },
  onSelectThread(key) {
    draftMode = false
    activeKey = key
    messages = []
    chat.update({ threads, activeKey, messages })
    void refreshConversation().catch(handlePollFailure)
    if (window.matchMedia('(max-width: 860px)').matches) switchMobilePanel('conversation')
  },
  async onSend(text) {
    const thread = activeKey?.startsWith('cli:') ? activeKey.slice('cli:'.length) : undefined
    const result = await api.sendMessage(text, thread)
    activeKey = result.threadKey
    draftMode = false
    chat.clearComposer()
    await refreshConversation()
    chat.focusComposer()
  },
})
const tickets = createTicketsView(document, {
  async onAnswer(ticketId) {
    const ticket = currentTickets.find((item) => item.id === ticketId)
    if (!ticket?.threadKey) return
    draftMode = false
    activeKey = ticket.threadKey
    messages = []
    chat.update({ threads, activeKey, messages })
    await refreshConversation()
    chat.focusComposer()
    if (window.matchMedia('(max-width: 860px)').matches) switchMobilePanel('conversation')
  },
  async onStop(ticketId) {
    await api.stopTicket(ticketId, '从网页面板停止')
    tickets.markSubmitted(ticketId)
  },
})
const memory = createMemoryView(document, {
  async onLoad({ q, project }) {
    const result = await api.memory({ q, project, limit: 100 })
    return result.entries
  },
  async onCreate(input) {
    return api.remember(input.text, input.project, input.supersedes)
  },
  async onForget(id, reason) {
    return api.forget(id, reason)
  },
})

function switchView(name) {
  workspace.dataset.view = name
  mobilePanelNav.hidden = name === 'memory'
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === name))
  }
  if (name === 'memory') {
    memory.setProjects(currentOverview?.projects ?? [])
    void memory.refresh()
  }
}

function switchMobilePanel(name) {
  workspace.dataset.mobilePanel = name
  for (const button of document.querySelectorAll('[data-mobile-panel]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mobilePanel === name))
  }
}

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => switchView(button.dataset.view))
}
for (const button of document.querySelectorAll('[data-mobile-panel]')) {
  button.addEventListener('click', () => switchMobilePanel(button.dataset.mobilePanel))
}

async function refreshConversation() {
  const listed = await api.threads(100)
  threads = listed.threads
  if (!activeKey && !draftMode && threads.length) activeKey = threads[0].key
  if (activeKey) {
    const read = await api.messages(activeKey, 100)
    messages = read.messages
  } else {
    messages = []
  }
  chat.update({ threads, activeKey, messages })
}

function handlePollFailure(error) {
  if (error instanceof ApiError && error.status === 401) {
    stopped = true
    status.showFatal('令牌失效了，请从终端重新打开网页面板链接。')
    return
  }
  failures++
  status.disconnected()
}

async function poll() {
  if (!api || stopped || polling) return
  polling = true
  try {
    const overview = await api.overview()
    failures = 0
    currentOverview = overview
    status.update(overview)
    const [listed, ticketData] = await Promise.all([api.threads(100), api.tickets()])
    threads = listed.threads
    if (!activeKey && !draftMode && threads.length) activeKey = threads[0].key
    messages = activeKey ? (await api.messages(activeKey, 100)).messages : []
    currentTickets = ticketData.tickets
    chat.update({ threads, activeKey, messages })
    tickets.update(currentTickets, currentOverview.projects)
  } catch (error) {
    handlePollFailure(error)
  } finally {
    polling = false
    schedule()
  }
}

function schedule() {
  clearTimeout(timer)
  if (stopped || document.hidden) return
  const delay = failures ? Math.min(POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) : POLL_MS
  timer = setTimeout(poll, delay)
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer)
    return
  }
  if (!stopped) poll()
})

if (!api) status.showFatal('没有找到访问令牌，请从终端重新打开网页面板链接。')
else poll()
