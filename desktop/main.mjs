import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Menu, session } from 'electron'
import { assertNodeVersion, resolveCli, resolveNode } from './src/node-runtime.mjs'
import { startPanel } from './src/panel-process.mjs'
import { isPanelUrl } from './src/window-policy.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WINDOW_TITLE = 'resident 网页面板'
const WINDOW_BACKGROUND = '#171a19'

let mainWindow
let panel
let panelOrigin
let stopping = false
let shutdownStarted = false
let quitReady = false

function focusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function installWindowPolicy(window) {
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isPanelUrl(url, panelOrigin)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isPanelUrl(url, panelOrigin)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

async function prepareSession() {
  const defaultSession = session.defaultSession
  await defaultSession.setProxy({ mode: 'direct' })
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  defaultSession.setPermissionCheckHandler(() => false)
  defaultSession.on('will-download', (event) => {
    event.preventDefault()
  })
}

function createWindow() {
  const window = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  })
  installWindowPolicy(window)
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  return window
}

async function loadPanel(url) {
  panelOrigin = new URL(url).origin
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  await mainWindow.loadURL(url)
}

async function restartPanel() {
  panel = undefined
  const nodePath = resolveNode(process.env)
  assertNodeVersion(nodePath)
  const cliPath = resolveCli(ROOT)
  const started = await startPanel({ nodePath, cliPath, env: process.env })
  panel = started
  started.child.once('exit', (code, signal) => {
    if (stopping || shutdownStarted || panel !== started) return
    panel = undefined
    void handlePanelExit(code, signal)
  })
  await loadPanel(started.url)
}

async function handlePanelExit(code, signal) {
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: '面板服务已退出',
    message: '网页面板服务意外退出了。',
    detail: `退出码：${code ?? signal ?? '未知'}。可以重启面板，或退出桌面窗口。`,
    buttons: ['重启', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (choice.response !== 0) {
    app.quit()
    return
  }
  try {
    await restartPanel()
    focusWindow()
  } catch (error) {
    await fatal(error)
  }
}

async function stopPanel() {
  const running = panel
  panel = undefined
  if (running) await running.stop()
}

async function fatal(error) {
  if (shutdownStarted) return
  shutdownStarted = true
  stopping = true
  try {
    await stopPanel()
  } catch {}
  await dialog.showMessageBox({
    type: 'error',
    title: '无法启动桌面窗口',
    message: '无法启动桌面窗口',
    detail: `${error instanceof Error ? error.message : String(error)}\n\n请确认已运行 npm run build，并安装 Node 24.13 或设置 RESIDENT_NODE。`,
    buttons: ['退出'],
    defaultId: 0,
    noLink: true,
  })
  app.exit(1)
}

async function shutdown() {
  if (shutdownStarted) return
  shutdownStarted = true
  stopping = true
  await stopPanel()
}

function start() {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', focusWindow)
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitReady) return
    event.preventDefault()
    void shutdown().finally(() => {
      quitReady = true
      app.quit()
    })
  })
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null)
      await prepareSession()
      await restartPanel()
    })
    .catch((error) => void fatal(error))
}

start()
