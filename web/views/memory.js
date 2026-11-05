import { el, emptyState, replace } from '../dom.js'
import { formatTime } from '../format.js'

const MAX_TEXT_CHARS = 20_000

export function createMemoryView(documentRoot, handlers) {
  const panel = documentRoot.querySelector('#memory-panel')
  const search = el('input', {
    attrs: { type: 'search', placeholder: '搜索记忆（中文两字也可以）', 'aria-label': '搜索记忆' },
  })
  const project = el('select', { attrs: { 'aria-label': '项目范围' } })
  const searchButton = el('button', { text: '搜索', attrs: { type: 'submit', 'data-memory-search': '' } })
  const refreshButton = el('button', { text: '刷新', attrs: { type: 'button', 'data-memory-refresh': '' } })
  const searchForm = el('form', { className: 'memory-tools' }, [search, project, searchButton, refreshButton])
  const textarea = el('textarea', {
    className: 'memory-input',
    attrs: {
      rows: '3',
      maxlength: String(MAX_TEXT_CHARS),
      placeholder: '新增一条规则，例如：提交信息都用中文',
      'aria-label': '新记忆内容',
    },
  })
  const saveButton = el('button', { text: '记下', attrs: { type: 'submit', 'data-memory-save': '' } })
  const notice = el('div', { className: 'memory-notice', attrs: { 'aria-live': 'polite' } })
  const error = el('div', { className: 'memory-error', attrs: { role: 'alert' } })
  const addForm = el('form', { className: 'memory-form' }, [
    textarea,
    el('div', { className: 'memory-actions' }, [saveButton]),
  ])
  const list = el('div', { className: 'memory-list' })
  notice.hidden = true
  error.hidden = true
  let entries = []
  let supersedes = null
  let loading = false
  let saving = false
  let forgetting = false
  let loadGeneration = 0

  replace(
    panel,
    el('div', { className: 'memory-heading' }, [el('h2', { text: '记忆' }), searchForm]),
    addForm,
    notice,
    error,
    list,
  )

  function setProjects(projects = []) {
    const selected = project.value
    replace(project, el('option', { text: '全部项目', attrs: { value: '' } }))
    for (const item of projects) project.append(el('option', { text: item.id, attrs: { value: item.id } }))
    if ([...project.options].some((option) => option.value === selected)) project.value = selected
  }

  function showNotice(message) {
    notice.hidden = false
    notice.textContent = message
  }

  function clearMessages() {
    notice.hidden = true
    notice.textContent = ''
    error.hidden = true
    error.textContent = ''
  }

  function showError(message) {
    error.hidden = false
    error.textContent = message
  }

  function scopeLabel(scope) {
    return scope === 'global' ? '全局' : scope.replace(/^project:/, '项目：')
  }

  function entryCard(entry) {
    const body = el('p', { className: 'memory-body', text: entry.body })
    const expand = el('button', { text: '查看', attrs: { type: 'button' } })
    expand.addEventListener('click', () => {
      const expanded = body.classList.toggle('is-expanded')
      expand.textContent = expanded ? '收起' : '查看'
    })
    return el('article', { className: 'memory-card', attrs: { 'data-memory-id': entry.id } }, [
      el('div', { className: 'memory-card-header' }, [
        el('strong', { text: scopeLabel(entry.scope) }),
        entry.pinned ? el('span', { className: 'memory-pinned', text: '规则' }) : null,
        el('time', { text: formatTime(entry.at) }),
      ]),
      body,
      el('div', { className: 'memory-card-actions' }, [
        expand,
        el('button', { text: '取代', attrs: { type: 'button', 'data-supersede': entry.id } }),
        el('button', { text: '作废', attrs: { type: 'button', 'data-forget': entry.id } }),
      ]),
    ])
  }

  function render() {
    if (!entries.length) replace(list, emptyState('还没有记忆。可以换个词，或新增一条规则。'))
    else replace(list, ...entries.map(entryCard))
    for (const button of list.querySelectorAll('[data-supersede]')) {
      button.addEventListener('click', () => beginSupersede(button.dataset.supersede))
    }
    for (const button of list.querySelectorAll('[data-forget]')) {
      button.addEventListener('click', () => void forget(button.dataset.forget))
    }
  }

  async function load(q = search.value.trim(), selectedProject = project.value) {
    const generation = ++loadGeneration
    const next = await handlers.onLoad({ q, project: selectedProject })
    if (generation !== loadGeneration) return
    entries = next
    render()
  }

  async function refresh() {
    if (loading) return
    loading = true
    clearMessages()
    try {
      await load()
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : '读取记忆失败。')
    } finally {
      loading = false
    }
  }

  function beginSupersede(id) {
    const entry = entries.find((item) => item.id === id)
    if (!entry) return
    supersedes = id
    textarea.value = entry.body
    project.value = entry.scope.startsWith('project:') ? entry.scope.slice('project:'.length) : ''
    showNotice(`将用下一条内容取代 ${id}。原记录仍会留在文件里。`)
    textarea.focus()
  }

  async function save() {
    if (saving) return
    clearMessages()
    const text = textarea.value
    if (!text.trim()) {
      showError('记忆内容不能为空。')
      return
    }
    if (text.length > MAX_TEXT_CHARS) {
      showError(`记忆最多 ${MAX_TEXT_CHARS} 字。`)
      return
    }
    saving = true
    saveButton.disabled = true
    try {
      await handlers.onCreate({ text, project: project.value || undefined, supersedes })
      textarea.value = ''
      supersedes = null
      search.value = ''
      showNotice('已记下。')
      await load('', project.value)
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : '保存失败，请重试。')
    } finally {
      saving = false
      saveButton.disabled = false
    }
  }

  async function forget(id) {
    if (forgetting) return
    if (!window.confirm('确定作废这条记忆吗？它在搜索和列表里会消失，但原文仍留在记忆文件中。')) return
    clearMessages()
    forgetting = true
    try {
      await handlers.onForget(id, '从网页面板作废')
      showNotice('已作废，原文仍留在记忆文件里。')
      await load(search.value.trim(), project.value)
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : '作废失败，请重试。')
    } finally {
      forgetting = false
    }
  }

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void refresh()
  })
  refreshButton.addEventListener('click', () => void refresh())
  addForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void save()
  })

  render()

  return {
    panel,
    setProjects,
    refresh,
    update(next) {
      entries = next
      render()
    },
  }
}
