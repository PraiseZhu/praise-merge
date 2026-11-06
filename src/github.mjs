// GitHub REST / GraphQL 客户端。只用调用方给的令牌提供者，不读环境变量里的令牌，不调用 gh。
// 写请求 = REST 非 GET，或 GraphQL 文本里含 mutation。影子模式下写请求在发出前就拒绝。

export class GitHubError extends Error {
  constructor(method, path, status, detail) {
    super(`${method} ${path} -> ${status}${detail ? ` ${detail}` : ''}`)
    this.name = 'GitHubError'
    this.method = method
    this.path = path
    this.status = status
  }
}

export class ShadowWriteError extends Error {
  constructor(method, path) {
    super(`影子模式拒绝写请求: ${method} ${path}`)
    this.name = 'ShadowWriteError'
  }
}

export function isWriteRequest(method, path, body) {
  if (path === '/graphql') return /\bmutation\b/.test(body?.query ?? '')
  return method !== 'GET'
}

export function createClient({ getToken, fetchImpl = fetch, baseUrl = 'https://api.github.com', shadow = true }) {
  async function request(method, path, body) {
    if (shadow && isWriteRequest(method, path, body)) throw new ShadowWriteError(method, path)
    const token = await getToken()
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) throw new GitHubError(method, path, res.status, typeof data?.message === 'string' ? data.message.slice(0, 200) : '')
    return data
  }

  async function graphql(query, variables = {}) {
    const data = await request('POST', '/graphql', { query, variables })
    if (data?.errors?.length) throw new GitHubError('POST', '/graphql', 200, data.errors.map((e) => e.message).join('; ').slice(0, 200))
    return data.data
  }

  return { request, graphql, shadow }
}
