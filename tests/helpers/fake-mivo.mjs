// Mivo 车道测试用的假 GitHub：规则集、合并队列、main 与集成分支的 CI、PR 的 GraphQL 状态、入队 mutation。
import { createClient } from '../../src/github.mjs'
import { createStore } from '../../src/queue.mjs'
import { toPolicy } from '../../src/policy.mjs'
import { loadGates } from '../../src/gates/index.mjs'
import { loadLanes } from '../../src/lanes/index.mjs'
import { makeTempDir } from './fake-github.mjs'

export const MIVO = 'xindong/mivo-canvas-plugin'
export const MIVO_HEAD = 'd'.repeat(40)
export const MIVO_MAIN = 'a'.repeat(40)
export const MIVO_INT = 'integration/x'
export const MIVO_INT_SHA = '9'.repeat(40)
export const MIVO_CHECKS = [
  'lint + tsc + unit + logging', 'structure guard (anti-regression)', 'secret scan (gitleaks)', 'cindyplugin build',
  'pr-format-gate (title/body template)', 'verify', 'pr-ci-freshness', 'review-pr',
]

export function makeMivoWorld(overrides = {}) {
  const prs = {}
  for (const n of [1, 2]) {
    prs[n] = {
      rest: { number: n, state: 'open', merged: false, draft: false, user: { login: 'PraiseZhu' }, base: { ref: 'main' }, head: { sha: MIVO_HEAD }, labels: [] },
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
    // 合并提交的父提交；null 表示就是合并请求发出时的 main
    mergeParent: null,
    checks: MIVO_CHECKS.map((name, i) => ({ id: i + 1, name, status: 'completed', conclusion: 'success', app: { id: 15368 } })),
    threads: [],
    prs,
    // 集成分支规则集（作用于 integration/* 的全部分支）与各集成分支的头、ci.yml push run
    integrationRules: [{ type: 'required_status_checks', parameters: { required_status_checks: toIntegrationChecks(MIVO_CHECKS).map((context) => ({ context, integration_id: 15368 })) } }],
    integration: { [MIVO_INT]: { sha: MIVO_INT_SHA, runs: { [MIVO_INT_SHA]: { status: 'completed', conclusion: 'success' } } } },
    ...overrides,
  }
}

export const labeledEvent = (label, login, id, event = 'labeled') => ({ id, event, label: { name: label }, actor: { login }, created_at: new Date(Date.UTC(2026, 10, 7, 0, 0, id % 60)).toISOString() })

export const toIntegrationChecks = (checks) => checks.map((c) => (c === 'review-pr' ? 'review-pr (integration)' : c))

// PR #1 目标是集成分支、没开队列、审查检查换成 review-pr (integration)
export function makeIntegrationWorld(overrides = {}) {
  const world = makeMivoWorld({ mergeQueue: null, ...overrides })
  world.prs[1].rest.base = { ref: MIVO_INT }
  if (!overrides.checks) world.checks = world.checks.map((c) => (c.name === 'review-pr' ? { ...c, name: 'review-pr (integration)' } : c))
  return world
}

export function createFakeMivo(world) {
  const calls = []
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  async function fetchImpl(url, init = {}) {
    const method = init.method ?? 'GET'
    const { pathname, searchParams } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ method, path: pathname, query: Object.fromEntries(searchParams), body })
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
      const branch = searchParams.get('branch')
      const runs = branch && branch !== 'main' ? world.integration[branch]?.runs ?? {} : world.mainRuns
      const run = runs[searchParams.get('head_sha')]
      return json(200, { workflow_runs: run ? [run] : [] })
    }
    let m
    if ((m = rest.match(/^\/rules\/branches\/(integration%2F.+)$/))) return json(200, world.integrationRules)
    if ((m = rest.match(/^\/branches\/(integration%2F.+)$/))) {
      const branch = world.integration[decodeURIComponent(m[1])]
      return branch ? json(200, { commit: { sha: branch.sha } }) : json(404, { message: 'Branch not found' })
    }
    if (/^\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(rest)) return json(200, { behind_by: world.behindBy })
    if (/^\/commits\/[0-9a-f]{40}$/.test(rest)) {
      if (world.commitReadFails) return json(502, { message: 'fake: Bad Gateway' })
      // merge 方式：第一父提交是合并时的目标分支头，第二父提交是 PR head
      if (world.lastMerge?.method === 'merge') return json(200, { parents: [world.mergeParent ?? world.lastMerge.baseSha, world.lastMerge.head].map((sha) => ({ sha })) })
      return json(200, { parents: [{ sha: world.mergeParent ?? world.mainSha }] })
    }
    // PR 列表：和 GitHub 一样按 state、base 过滤；per_page 最多 100，不翻页。listStatus：模拟列表请求失败的状态码
    if (rest === '/pulls' && method === 'GET') {
      if (world.listStatus) return json(world.listStatus, { message: 'fake: Service Unavailable' })
      const state = searchParams.get('state') ?? 'open'
      const base = searchParams.get('base')
      // listOrder：指定列表返回顺序（PR 号数组），模拟 GitHub 按更新时间排序后顺序变化
      const list = (world.listOrder ? world.listOrder.map((n) => world.prs[n]) : Object.values(world.prs)).map((p) => p.rest)
        .filter((p) => (state === 'all' || p.state === state) && (!base || p.base.ref === base))
      return json(200, list.slice(0, Math.min(Number(searchParams.get('per_page') ?? 30), 100)))
    }
    // issue events：按时间正序分页。没写 events 时，PR 上现有的每个标签各有一条由 praisebuild[bot] 挂上的 labeled 事件；
    // eventsStatus：模拟读 events 失败的状态码
    if ((m = rest.match(/^\/issues\/(\d+)\/events$/)) && method === 'GET') {
      if (world.eventsStatus) return json(world.eventsStatus, { message: 'fake: events 读失败' })
      const pr = world.prs[m[1]]
      const all = pr.events ?? (pr.rest.labels ?? []).map((l, i) => labeledEvent(l.name, 'praisebuild[bot]', 1000 + i))
      const perPage = Math.min(Number(searchParams.get('per_page') ?? 30), 100)
      const page = Number(searchParams.get('page') ?? 1)
      return json(200, all.slice((page - 1) * perPage, page * perPage))
    }
    if ((m = rest.match(/^\/pulls\/(\d+)$/)) && method === 'GET') {
      // restOnReread：模拟第一次读之后、写之前 PR 被改（第二次起读到改过的 PR）
      const pr = world.prs[m[1]]
      pr.reads = (pr.reads ?? 0) + 1
      return json(200, pr.reads > 1 && pr.restOnReread ? { ...pr.rest, ...pr.restOnReread } : pr.rest)
    }
    if ((m = rest.match(/^\/pulls\/(\d+)\/merge$/)) && method === 'PUT') {
      if (world.mergeResponse !== 200) return json(world.mergeResponse, { message: 'fake: Head branch was modified' })
      const pr = world.prs[m[1]].rest
      world.lastMerge = { method: body.merge_method, head: body.sha, baseSha: pr.base.ref === 'main' ? world.mainSha : world.integration[pr.base.ref].sha }
      Object.assign(pr, { merged: true, state: 'closed' })
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

// autoIntake：policy 条目上的 auto_intake（不传就没有）
export async function makeMivoEnv({ world = makeMivoWorld(), shadow = false, autoIntake } = {}) {
  const fake = createFakeMivo(world)
  const client = createClient({ getToken: async () => 'test-installation-token', fetchImpl: fake.fetchImpl, shadow })
  const policy = toPolicy({ repos: { [MIVO]: { lane: 'mivo', required_checks: MIVO_CHECKS, checks_integration_id: 15368, ...(autoIntake ? { auto_intake: autoIntake } : {}) } } })
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
