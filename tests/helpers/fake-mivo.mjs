// Mivo 车道测试用的假 GitHub：规则集、合并队列、main CI、PR 的 GraphQL 状态、入队 mutation。
import { createClient } from '../../src/github.mjs'
import { createStore } from '../../src/queue.mjs'
import { toPolicy } from '../../src/policy.mjs'
import { loadGates } from '../../src/gates/index.mjs'
import { loadLanes } from '../../src/lanes/index.mjs'
import { makeTempDir } from './fake-github.mjs'

export const MIVO = 'xindong/mivo-canvas-plugin'
export const MIVO_HEAD = 'd'.repeat(40)
export const MIVO_MAIN = 'a'.repeat(40)
export const MIVO_CHECKS = [
  'lint + tsc + unit + logging', 'structure guard (anti-regression)', 'secret scan (gitleaks)', 'cindyplugin build',
  'pr-format-gate (title/body template)', 'verify', 'pr-ci-freshness', 'review-pr',
]

export function makeMivoWorld(overrides = {}) {
  const prs = {}
  for (const n of [1, 2]) {
    prs[n] = {
      rest: { number: n, state: 'open', merged: false, draft: false, user: { login: 'PraiseZhu' }, base: { ref: 'main' }, head: { sha: MIVO_HEAD } },
      gql: { id: `PR_${n}`, mergeStateStatus: 'CLEAN', mergeQueueEntry: null },
    }
  }
  return {
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: MIVO_CHECKS.map((context) => ({ context, integration_id: 15368 })) } }],
    mergeQueue: { id: 'MQ_1' },
    mainSha: MIVO_MAIN,
    // main 上各提交的 ci.yml push run；没有键就是还没有 run
    mainRuns: { [MIVO_MAIN]: { status: 'completed', conclusion: 'success' } },
    behindBy: 0,
    // 直接合并的应答：200 合入；数字表示 GitHub 拒绝的状态码
    mergeResponse: 200,
    checks: MIVO_CHECKS.map((name, i) => ({ id: i + 1, name, status: 'completed', conclusion: 'success', app: { id: 15368 } })),
    threads: [],
    prs,
    ...overrides,
  }
}

export function createFakeMivo(world) {
  const calls = []
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  async function fetchImpl(url, init = {}) {
    const method = init.method ?? 'GET'
    const { pathname, searchParams } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method, path: pathname, body })
    if (pathname === '/graphql') {
      const q = body.query
      if (q.includes('enqueuePullRequest')) {
        const pr = Object.values(world.prs).find((p) => p.gql.id === body.variables.id)
        pr.gql.mergeQueueEntry = { state: 'QUEUED' }
        return json(200, { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E1', state: 'QUEUED' } } } })
      }
      if (q.includes('reviewThreads')) return json(200, { data: { repository: { pullRequest: { reviewThreads: { totalCount: world.threads.length, nodes: world.threads } } } } })
      if (q.includes('mergeStateStatus')) return json(200, { data: { repository: { pullRequest: world.prs[body.variables.number].gql, mergeQueue: world.mergeQueue } } })
      return json(400, { message: 'fake: 未知查询' })
    }
    const prefix = `/repos/${MIVO}`
    const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null
    if (rest === null) return json(404, { message: 'Not Found' })
    if (rest === '/rules/branches/main') return json(200, world.rules)
    if (rest === '/branches/main') return json(200, { commit: { sha: world.mainSha } })
    if (rest === '/actions/workflows/ci.yml/runs') {
      const run = world.mainRuns[searchParams.get('head_sha')]
      return json(200, { workflow_runs: run ? [run] : [] })
    }
    let m
    if (/^\/compare\/main\.\.\.[0-9a-f]{40}$/.test(rest)) return json(200, { behind_by: world.behindBy })
    if ((m = rest.match(/^\/pulls\/(\d+)$/)) && method === 'GET') return json(200, world.prs[m[1]].rest)
    if ((m = rest.match(/^\/pulls\/(\d+)\/merge$/)) && method === 'PUT') {
      if (world.mergeResponse !== 200) return json(world.mergeResponse, { message: 'fake: Head branch was modified' })
      Object.assign(world.prs[m[1]].rest, { merged: true, state: 'closed' })
      return json(200, { sha: 'f'.repeat(40), merged: true })
    }
    if ((m = rest.match(/^\/pulls\/(\d+)\/update-branch$/)) && method === 'PUT') return json(202, { message: 'Updating pull request branch.' })
    if (/^\/commits\/[^/]+\/check-runs$/.test(rest)) return json(200, { check_runs: world.checks })
    if (/^\/commits\/[^/]+\/status$/.test(rest)) return json(200, { statuses: [] })
    return json(404, { message: `fake: 未实现 ${method} ${rest}` })
  }
  return {
    fetchImpl,
    calls,
    writes: () => calls.filter((c) => (c.path === '/graphql' ? /\bmutation\b/.test(c.body.query) : c.method !== 'GET')),
  }
}

export async function makeMivoEnv({ world = makeMivoWorld(), shadow = false } = {}) {
  const fake = createFakeMivo(world)
  const client = createClient({ getToken: async () => 'test-installation-token', fetchImpl: fake.fetchImpl, shadow })
  const policy = toPolicy({ repos: { [MIVO]: { lane: 'mivo', required_checks: MIVO_CHECKS, checks_integration_id: 15368 } } })
  return { world, fake, client, clientFor: () => client, store: createStore(makeTempDir()), policy, gates: await loadGates(), lanes: await loadLanes(), shadow }
}

export function seedMivoItem(store, number = 1, overrides = {}) {
  const q = store.loadQueue()
  q.items.push({
    id: `${MIVO}#${number}`, repo: MIVO, number, status: 'queued', reason: 'queued', after: [],
    authorizedAt: new Date().toISOString(), authorizationText: '合并', sessionId: 's1',
    headShaAtAuth: MIVO_HEAD, seenHeads: [MIVO_HEAD], enqueuedAt: new Date().toISOString(), ...overrides,
  })
  store.saveQueue(q)
}
