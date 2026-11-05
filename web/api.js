export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function createApi(token, fetchImpl = globalThis.fetch) {
  async function request(path, options = {}) {
    const headers = { Authorization: `Bearer ${token}` }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetchImpl(path, {
      method: options.method || 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new ApiError(response.status, 'E_INTERNAL', '面板服务返回了无法读取的内容')
    }
    if (!response.ok || !payload?.ok) {
      const error = payload?.error
      throw new ApiError(response.status, error?.code || 'E_INTERNAL', error?.message || '请求失败')
    }
    return payload.data
  }

  function withQuery(path, values) {
    const query = new URLSearchParams()
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && value !== '') query.set(name, String(value))
    }
    const suffix = query.toString()
    return suffix ? `${path}?${suffix}` : path
  }

  return {
    overview: () => request('/api/overview'),
    threads: (limit = 100) => request(withQuery('/api/threads', { limit })),
    messages: (key, limit = 100) => request(withQuery(`/api/threads/${encodeURIComponent(key)}/messages`, { limit })),
    sendMessage: (text, thread) =>
      request('/api/messages', { method: 'POST', body: { text, ...(thread ? { thread } : {}) } }),
    tickets: () => request('/api/tickets'),
    stopTicket: (id, reason) =>
      request(`/api/tickets/${encodeURIComponent(id)}/stop`, {
        method: 'POST',
        body: { ...(reason ? { reason } : {}) },
      }),
    memory: (values = {}) => request(withQuery('/api/memory', values)),
    memoryEntry: (id) => request(`/api/memory/${encodeURIComponent(id)}`),
    remember: (text, project, supersedes) =>
      request('/api/memory', {
        method: 'POST',
        body: { text, ...(project ? { project } : {}), ...(supersedes ? { supersedes } : {}) },
      }),
    forget: (id, reason) =>
      request(`/api/memory/${encodeURIComponent(id)}/forget`, {
        method: 'POST',
        body: { ...(reason ? { reason } : {}) },
      }),
  }
}
