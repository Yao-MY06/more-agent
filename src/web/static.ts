/** The browser files are addressed by this fixed table, never by joining a request path. */
import { join } from 'node:path'
import { projectRoot } from '../config.ts'

export interface StaticAsset {
  file: string
  contentType: string
}

const WEB_ROOT = join(projectRoot(), 'web')
const HTML = 'text/html; charset=utf-8'
const CSS = 'text/css; charset=utf-8'
const JS = 'text/javascript; charset=utf-8'
const PNG = 'image/png'

const ASSETS: Readonly<Record<string, StaticAsset>> = {
  '/': { file: join(WEB_ROOT, 'index.html'), contentType: HTML },
  '/favicon.png': { file: join(WEB_ROOT, 'favicon.png'), contentType: PNG },
  '/style.css': { file: join(WEB_ROOT, 'style.css'), contentType: CSS },
  '/app.js': { file: join(WEB_ROOT, 'app.js'), contentType: JS },
  '/api.js': { file: join(WEB_ROOT, 'api.js'), contentType: JS },
  '/dom.js': { file: join(WEB_ROOT, 'dom.js'), contentType: JS },
  '/format.js': { file: join(WEB_ROOT, 'format.js'), contentType: JS },
  '/views/chat.js': { file: join(WEB_ROOT, 'views', 'chat.js'), contentType: JS },
  '/views/tickets.js': { file: join(WEB_ROOT, 'views', 'tickets.js'), contentType: JS },
  '/views/memory.js': { file: join(WEB_ROOT, 'views', 'memory.js'), contentType: JS },
  '/views/status.js': { file: join(WEB_ROOT, 'views', 'status.js'), contentType: JS },
}

export function staticAsset(pathname: string): StaticAsset | undefined {
  return ASSETS[pathname]
}
