// 测试用的假 GitHub：按路径路由到内存里的 world，记录每一次请求。私钥运行时现生成，不进仓库。
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../src/queue.mjs'
import { toPolicy } from '../../src/policy.mjs'
import { createClient } from '../../src/github.mjs'
import { loadGates } from '../../src/gates/index.mjs'
import { loadLanes } from '../../src/lanes/index.mjs'

export const HEAD = 'a'.repeat(40)
export const DIFF = 'diff --git a/x.txt b/x.txt\nindex 1111111..2222222 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n'
export const REPO = 'praisezhu/demo'

export function makePrivateKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
}

// 测试建的临时目录在进程退出时全部删掉，不留残余
const tempDirs = []
process.on('exit', () => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })
export function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'praise-merge-test-'))
  tempDirs.push(dir)
  return dir
}

export function makePr(overrides = {}) {
  return {
    number: 1,
    state: 'open',
    merged: false,
    draft: false,
    user: { login: 'PraiseZhu' },
    base: { ref: 'main' },
    head: { sha: HEAD },
    mergeable_state: 'clean',
    ...overrides,
  }
}

// world: { repos: { [repo]: { defaultBranch, prs: {n: pr}, checks: {sha: [run]}, statuses: {sha: [st]}, behind: {sha: n}, threads: {n: [{isResolved}]} } } }
export function createFakeGitHub(world) {
  const calls = []
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  async function fetchImpl(url, init = {}) {
    const method = init.method ?? 'GET'
    const { pathname, searchParams } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method, path: pathname, query: Object.fromEntries(searchParams), body, auth: init.headers?.Authorization })
    if (world.failWith) return reply(world.failWith, { message: 'Resource not accessible by integration' })

    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(pathname)) {
      return reply(201, { token: 'test-installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() })
    }
    if (method === 'POST' && pathname === '/graphql') {
      const { owner, name, number } = body.variables
      const threads = world.repos[`${owner}/${name}`.toLowerCase()]?.threads?.[number] ?? []
      return reply(200, { data: { repository: { pullRequest: { reviewThreads: { totalCount: threads.length, nodes: threads } } } } })
    }
    const m = pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/)
    if (!m) return reply(404, { message: 'Not Found' })
    const repo = world.repos[m[1].toLowerCase()]
    const rest = m[2] ?? ''
    if (!repo) return reply(404, { message: 'Not Found' })
    if (method === 'GET' && rest === '') return reply(200, { default_branch: repo.defaultBranch ?? 'main' })

    let r
    if ((r = rest.match(/^\/pulls\/(\d+)$/)) && method === 'GET' && init.headers?.Accept === 'application/vnd.github.diff') {
      const diff = repo.diffs?.[r[1]] ?? DIFF
      return new Response(diff, { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    if ((r = rest.match(/^\/pulls\/(\d+)$/)) && method === 'GET') {
      const pr = repo.prs[r[1]]
      return pr ? reply(200, pr) : reply(404, { message: 'Not Found' })
    }
    if ((r = rest.match(/^\/pulls\/(\d+)\/merge$/)) && method === 'PUT') {
      if (repo.mergeStatus) return reply(repo.mergeStatus, { message: 'Head branch was modified' })
      const pr = repo.prs[r[1]]
      pr.merged = true
      pr.state = 'closed'
      return reply(200, { sha: repo.mergeSha ?? 'm'.repeat(40), merged: true })
    }
    if ((r = rest.match(/^\/pulls\/(\d+)\/update-branch$/)) && method === 'PUT') return reply(202, { message: 'Updating pull request branch.' })
    if ((r = rest.match(/^\/commits\/([^/]+)\/check-runs$/)) && method === 'GET') {
      // 和 GitHub 一样分页（per_page 最多 100），带 total_count
      const all = repo.checks?.[r[1]] ?? []
      const perPage = Math.min(Number(searchParams.get('per_page') ?? 30), 100)
      const page = Number(searchParams.get('page') ?? 1)
      return reply(200, { total_count: all.length, check_runs: all.slice((page - 1) * perPage, page * perPage) })
    }
    // world.statuses[sha] 是这个提交上写过的全部 status（逐条列表接口的形状，带 creator）
    if ((r = rest.match(/^\/commits\/([^/]+)\/status$/)) && method === 'GET') {
      // 汇总接口：每个 context 只给最新一条，且和 GitHub 一样不带 creator
      const latest = new Map()
      for (const st of repo.statuses?.[r[1]] ?? []) if (!(latest.get(st.context)?.id > st.id)) latest.set(st.context, st)
      const all = [...latest.values()].map(({ creator, ...st }) => st)
      const page = Number(searchParams.get('page') ?? 1)
      const cap = repo.statusPageLimit ?? Infinity // 模拟 GitHub 只肯给到第几页
      const slice = page > cap ? [] : all.slice((page - 1) * 100, page * 100)
      return reply(200, { total_count: all.length, statuses: slice })
    }
    if ((r = rest.match(/^\/commits\/([^/]+)\/statuses$/)) && method === 'GET') {
      // 逐条列表接口：全部历史，按时间倒序（id 大的在前），带 creator
      const all = [...(repo.statuses?.[r[1]] ?? [])].sort((a, b) => b.id - a.id)
      const page = Number(searchParams.get('page') ?? 1)
      const cap = repo.statusListPageLimit ?? Infinity
      return reply(200, page > cap ? [] : all.slice((page - 1) * 100, page * 100))
    }
    // 仓库活动：world.pushes = [{ ref, after, timestamp }]，按时间倒序
    if (rest === '/activity' && method === 'GET') {
      const ref = searchParams.get('ref')
      const pushes = (repo.pushes ?? []).filter((p) => !ref || p.ref === ref).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      return reply(200, pushes.map((p) => ({ activity_type: 'push', ...p })))
    }
    if ((r = rest.match(/^\/compare\/([^.]+)\.\.\.(.+)$/)) && method === 'GET') {
      return reply(200, { behind_by: repo.behind?.[r[2]] ?? 0 })
    }
    return reply(404, { message: `fake: 未实现 ${method} ${rest}` })
  }

  return {
    fetchImpl,
    calls,
    writes: () => calls.filter((c) => !(c.method === 'GET' || /\/access_tokens$/.test(c.path) || (c.path === '/graphql' && !/\bmutation\b/.test(c.body?.query ?? '')))),
  }
}

// 证据 status：默认是 PraiseZhu 写的、patch-id 与默认 DIFF 一致的 success
export const evidenceStatus = (patch, overrides = {}) => ({
  id: 100, context: 'praise-merge/gpt-review', state: 'success', creator: { login: 'PraiseZhu' }, description: `patch:${patch} by:gpt-5.5`, ...overrides,
})

// 合并授权证据（pr-merge skill 在用户说「合并」时写）；created_at 默认是现在
export const authStatus = (patch, overrides = {}) => ({
  id: 99, context: 'praise-merge/authorization', state: 'success', creator: { login: 'PraiseZhu' }, description: `patch:${patch} by:session-s1`, created_at: new Date().toISOString(), ...overrides,
})

export const passingRun = (name, id = 1) => ({ id, name, status: 'completed', conclusion: 'success', app: { id: 15368 } })

export function makeWorld(overrides = {}) {
  return {
    repos: {
      [REPO]: {
        defaultBranch: 'main',
        prs: { 1: makePr() },
        checks: { [HEAD]: [passingRun('verify')] },
        statuses: {},
        behind: {},
        threads: {},
        ...overrides,
      },
    },
  }
}

export const testPolicy = () => toPolicy({ repos: { 'PraiseZhu/demo': { lane: 'personal', required_checks: ['verify'] } } })

// 组好一轮 tick 需要的依赖；evidence 门禁可替换成放行，用来单测其余门禁
export async function makeEnv({ world, shadow = true, passEvidence = false } = {}) {
  const fake = createFakeGitHub(world ?? makeWorld())
  const store = createStore(makeTempDir())
  const client = createClient({ getToken: async () => 'test-installation-token', fetchImpl: fake.fetchImpl, shadow })
  let gates = await loadGates()
  if (passEvidence) gates = gates.map((g) => (g.id === 'evidence' ? { ...g, check: () => ({ ok: true }) } : g))
  return { fake, store, client, clientFor: () => client, gates, lanes: await loadLanes(), policy: testPolicy(), shadow }
}

export function seedItem(store, overrides = {}) {
  const q = store.loadQueue()
  q.items.push({
    id: `${REPO}#1`, repo: REPO, number: 1, status: 'queued', reason: 'queued', after: [],
    authorizedAt: new Date().toISOString(), authorizationText: '合并', sessionId: 's1',
    headShaAtAuth: HEAD, seenHeads: [HEAD], enqueuedAt: new Date().toISOString(), ...overrides,
  })
  store.saveQueue(q)
}

export function writeConfig(dir, { keyPath, shadow = true }) {
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ app_id: 1, installations: { PraiseZhu: 2 }, key_path: keyPath, shadow }))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ repos: { 'PraiseZhu/demo': { lane: 'personal', required_checks: ['verify'] } } }))
}
