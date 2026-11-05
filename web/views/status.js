import { replace } from '../dom.js'

export function createStatusView(documentRoot) {
  const runner = documentRoot.querySelector('#runner-indicator')
  const queued = documentRoot.querySelector('#queue-count')
  const tickets = documentRoot.querySelector('#ticket-count')
  const connection = documentRoot.querySelector('#connection-banner')
  const runnerBanner = documentRoot.querySelector('#runner-banner')

  function connected() {
    connection.hidden = true
    connection.textContent = ''
  }

  function disconnected(message = '连接不上面板服务，稍后会自动重试') {
    connection.hidden = false
    connection.textContent = message
  }

  function update(overview) {
    const status = overview.status
    runner.textContent = overview.runnerUp ? '● runner 运行中' : '● runner 没运行'
    runner.classList.toggle('is-up', overview.runnerUp)
    runner.classList.toggle('is-down', !overview.runnerUp)
    queued.textContent = `排队 ${status.spoolWaiting}`
    tickets.textContent = `工单 ${status.tickets}`
    runnerBanner.hidden = overview.runnerUp
    connected()
  }

  function showFatal(message) {
    disconnected(message)
    runner.textContent = '● 未连接'
    runner.classList.remove('is-up')
    runner.classList.add('is-down')
    replace(runnerBanner)
    runnerBanner.hidden = true
  }

  return { update, connected, disconnected, showFatal }
}
