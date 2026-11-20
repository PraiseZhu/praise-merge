// #53：红灯事件带上该通知谁。cause 是弄红它的 PR（从红的分支头沿第一父提交往回找到最早变红的提交），owners 是集成分支负责人。
// 飞书发给谁、怎么转给用户见 tests/red-notice.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { runTick } from '../src/tick.mjs'
import { toEventLines } from '../src/events.mjs'
import { MAX_CAUSE_STEPS, selectCausePull, toBranchOwners, withRedCause } from '../src/ci-watch.mjs'
import { createClient } from '../src/github.mjs'
import { createTokenProvider } from '../src/app-token.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, seedMivoItem, greenBranchChecks, pushWorkflowRun, MIVO, MIVO_MAIN, MIVO_INT, MIVO_INT_SHA } from './helpers/fake-mivo.mjs'

const tick = (env) => runTick({ ...env, now: Date.now() })
const ofType = (events, type) => events.filter((e) => e.type === type)
const FAILED = { status: 'completed', conclusion: 'failure' }
const PASSED = { status: 'completed', conclusion: 'success' }
const sha = (char) => char.repeat(40)
// 把这个提交合进 base 的 PR（合并提交就是它）
const mergedPull = (number, login, mergeSha, base = 'main') => ({ number, user: { login }, base: { ref: base }, merged_at: '2026-11-20T13:31:00Z', merge_commit_sha: mergeSha })
const commit = (parent, login = null) => ({ parents: parent ? [{ sha: parent }] : [], author: login ? { login } : null })

async function envWith(world) {
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store, 2)
  return env
}

// main 上一个绿的提交：ci.yml 成功，push 触发的检查都绿
function addGreenMainCommit(world, commitSha) {
  world.mainRuns[commitSha] = PASSED
  world.branchChecks[commitSha] = greenBranchChecks()
  world.workflowRuns[commitSha] = [pushWorkflowRun()]
}

// SC1

test('#53 SC1 main 红、父提交是绿的：cause 是把红提交合进来的 PR 和它的作者，找准了', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const green = sha('b')
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(green, 'merger')
  world.commitPulls[MIVO_MAIN] = [mergedPull(77, 'alice', MIVO_MAIN)]
  addGreenMainCommit(world, green)
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'main_ci_red')
  assert.equal(red.length, 1)
  assert.deepEqual(red[0].cause, { sha: MIVO_MAIN, pr: 77, author: 'alice', certain: true })
  assert.equal(red[0].owners, undefined, 'main 没有分支负责人')
  assert.deepEqual(env.fake.writes(), [])
})

test('#53 SC1 叫醒伙伴的事件行带 cause 和 owners；别的事件行不带', async () => {
  const lines = toEventLines([
    { type: 'integration_ci_red', repo: MIVO, branch: MIVO_INT, head: MIVO_INT_SHA, reason: 'r', cause: { sha: MIVO_INT_SHA, pr: 7, author: 'alice', certain: true }, owners: ['bob'] },
    { type: 'main_ci_red', repo: MIVO, branch: 'main', head: MIVO_MAIN, reason: 'r', cause: null },
    { type: 'merged', repo: MIVO, pr: 3, head: 'h' },
  ]).map((line) => JSON.parse(line))
  assert.deepEqual(lines[0].cause, { sha: MIVO_INT_SHA, pr: 7, author: 'alice', certain: true })
  assert.deepEqual(lines[0].owners, ['bob'])
  assert.equal(lines[1].cause, null, '查不到时写明 null')
  assert.ok(!('cause' in lines[2]) && !('owners' in lines[2]))
})

// SC2

test('#53 SC2 连续红：分支头 B 红、父提交 A 也红、A 的父提交是绿的，cause 是 A 的 PR，不是 B 的', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const [b, a, green] = [MIVO_MAIN, sha('b'), sha('c')]
  world.mainRuns[b] = FAILED
  world.mainRuns[a] = FAILED
  world.commits[b] = commit(a)
  world.commits[a] = commit(green)
  world.commitPulls[b] = [mergedPull(2612, 'late-author', b)]
  world.commitPulls[a] = [mergedPull(2599, 'aj0928', a)]
  addGreenMainCommit(world, green)
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'main_ci_red')
  assert.deepEqual(red.map((e) => e.cause), [{ sha: a, pr: 2599, author: 'aj0928', certain: true }])
  assert.equal(red[0].head, b, '事件本身仍是当前分支头')
})

test('#53 SC2 父提交没法确认（被取消、被跳过、等人工操作、已结束但没有结论、还在跑、没有运行记录）：停在当前提交，certain 为 false', async () => {
  const completed = (conclusion) => ({ status: 'completed', conclusion })
  for (const [name, parentRun] of [['cancelled', completed('cancelled')], ['skipped', completed('skipped')], ['action_required', completed('action_required')],
    ['completed_without_conclusion', completed(null)], ['completed_conclusion_missing', { status: 'completed' }], ['in_progress', { status: 'in_progress', conclusion: null }], ['no_run', null]]) {
    const world = makeMivoWorld({ mergeQueue: null })
    const parent = sha('b')
    world.mainRuns[MIVO_MAIN] = FAILED
    if (parentRun) world.mainRuns[parent] = parentRun
    world.commits[MIVO_MAIN] = commit(parent)
    world.commits[parent] = commit(sha('c'))
    world.commitPulls[MIVO_MAIN] = [mergedPull(11, 'bob', MIVO_MAIN)]
    world.commitPulls[parent] = [mergedPull(10, 'alice', parent)]
    const env = await envWith(world)
    const red = ofType((await tick(env)).events, 'main_ci_red')
    assert.deepEqual(red.map((e) => e.cause), [{ sha: MIVO_MAIN, pr: 11, author: 'bob', certain: false }], name)
  }
})

test(`#53 SC2 一路都红：最多往回走 ${MAX_CAUSE_STEPS} 步，停在第 ${MAX_CAUSE_STEPS} 个父提交，certain 为 false`, async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  // chain[0] 是分支头，往后每个是前一个的父提交；都红
  const chain = [MIVO_MAIN, ...Array.from({ length: MAX_CAUSE_STEPS + 3 }, (_, i) => String(i + 1).padStart(40, '0'))]
  chain.forEach((commitSha, i) => {
    world.mainRuns[commitSha] = FAILED
    world.commits[commitSha] = commit(chain[i + 1] ?? null)
    world.commitPulls[commitSha] = [mergedPull(100 + i, `author-${i}`, commitSha)]
  })
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'main_ci_red')
  assert.deepEqual(red.map((e) => e.cause), [{ sha: chain[MAX_CAUSE_STEPS], pr: 100 + MAX_CAUSE_STEPS, author: `author-${MAX_CAUSE_STEPS}`, certain: false }])
})

// SC3

test('#53 SC3 集成分支红：owners 取目标分支是它的开放 PR 的作者（按 PR 号、去重），cause 按这个分支上的 CI 往回找', async () => {
  const world = makeIntegrationWorld()
  const [parent, green] = [sha('b'), sha('c')]
  world.integration[MIVO_INT].runs = { [MIVO_INT_SHA]: FAILED, [parent]: FAILED, [green]: PASSED }
  world.branchChecks[green] = greenBranchChecks()
  world.workflowRuns[green] = [pushWorkflowRun()]
  world.commits[MIVO_INT_SHA] = commit(parent)
  world.commits[parent] = commit(green)
  world.commitPulls[parent] = [mergedPull(2599, 'aj0928', parent, MIVO_INT)]
  world.prs[3] = { rest: { number: 3, state: 'open', merged: false, draft: false, user: { login: 'carol' }, base: { ref: MIVO_INT }, head: { sha: sha('e') }, labels: [] } }
  world.prs[4] = { rest: { number: 4, state: 'open', merged: false, draft: false, user: { login: 'praisezhu' }, base: { ref: MIVO_INT }, head: { sha: sha('f') }, labels: [] } }
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'integration_ci_red')
  assert.equal(red.length, 1)
  assert.deepEqual(red[0].owners, ['PraiseZhu', 'carol'], '#1 PraiseZhu、#3 carol；#4 praisezhu 只是大小写不同')
  assert.deepEqual(red[0].cause, { sha: parent, pr: 2599, author: 'aj0928', certain: true })
})

test('#53 SC3 有同仓、源分支是它的开放 PR（合回 main 的阶段 PR）时，负责人只取这种 PR 的作者', () => {
  const targeting = { number: 1, user: { login: 'contributor' }, base: { ref: MIVO_INT }, head: { ref: 'feat/x', repo: { full_name: MIVO } } }
  const stage = { number: 9, user: { login: 'stage-owner' }, base: { ref: 'main' }, head: { ref: MIVO_INT, repo: { full_name: MIVO } } }
  const forkStage = { number: 8, user: { login: 'outsider' }, base: { ref: 'main' }, head: { ref: MIVO_INT, repo: { full_name: 'Someone/fork' } } }
  const other = { number: 2, user: { login: 'elsewhere' }, base: { ref: 'integration/other' }, head: { ref: 'feat/y', repo: { full_name: MIVO } } }
  assert.deepEqual(toBranchOwners([targeting, stage, forkStage, other], MIVO, MIVO_INT), ['stage-owner'])
  assert.deepEqual(toBranchOwners([targeting, forkStage, other], MIVO, MIVO_INT), ['contributor'], 'fork 里同名的源分支不算阶段 PR')
  // 源分支是它、但合进别的集成分支的 PR 不是「合回 main 的阶段 PR」，不能盖过真正指向它的 PR 的作者
  const intoOtherIntegration = { number: 7, user: { login: 'not-stage' }, base: { ref: 'integration/other' }, head: { ref: MIVO_INT, repo: { full_name: MIVO } } }
  assert.deepEqual(toBranchOwners([targeting, intoOtherIntegration], MIVO, MIVO_INT), ['contributor'])
  assert.deepEqual(toBranchOwners([other], MIVO, MIVO_INT), [])
})

// SC5

test('#53 SC5 红提交没有对应的 PR（直接推送）：pr 为 null，author 取提交的 GitHub 作者账号；只是包含这个提交的开放 PR 不算', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const green = sha('b')
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(green, 'dave')
  // 集成分支合回 main 的阶段 PR 也会出现在「提交关联的 PR」里：没合并，合并提交也不是它
  world.commitPulls[MIVO_MAIN] = [{ number: 5, user: { login: 'stage-owner' }, base: { ref: 'main' }, merged_at: null, merge_commit_sha: sha('d') }]
  addGreenMainCommit(world, green)
  const env = await envWith(world)
  assert.deepEqual(ofType((await tick(env)).events, 'main_ci_red').map((e) => e.cause), [{ sha: MIVO_MAIN, pr: null, author: 'dave', certain: true }])
})

test('#53 SC5 提交关联的 PR 怎么选：合并提交就是它的优先；其次已合并且目标分支对得上的；都没有返回 null', () => {
  const byMergeSha = mergedPull(1, 'a', MIVO_MAIN, 'integration/other')
  const byBase = { ...mergedPull(2, 'b', sha('d')), base: { ref: 'main' } }
  const openOnly = { number: 3, user: { login: 'c' }, base: { ref: 'main' }, merged_at: null, merge_commit_sha: null }
  assert.equal(selectCausePull([openOnly, byBase, byMergeSha], { sha: MIVO_MAIN, branch: 'main' }).number, 1)
  assert.equal(selectCausePull([openOnly, byBase], { sha: MIVO_MAIN, branch: 'main' }).number, 2)
  assert.equal(selectCausePull([openOnly], { sha: MIVO_MAIN, branch: 'main' }), null)
  assert.equal(selectCausePull([], { sha: MIVO_MAIN, branch: 'main' }), null)
})

test('#53 SC5 提交关联的 PR 应答不是列表（异常应答）：按读失败处理，cause 为 null，不当成「直接推送」', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(sha('b'), 'dave')
  world.commitPulls[MIVO_MAIN] = null
  addGreenMainCommit(world, sha('b'))
  const env = await envWith(world)
  const events = (await tick(env)).events
  assert.deepEqual(ofType(events, 'main_ci_red').map((e) => e.cause), [null])
  assert.match(ofType(events, 'ci_watch_failed')[0].reason, /关联的 PR 应答不是列表/)
})

test('#53 SC5 找弄红它的 PR 时读 GitHub 失败：红灯照发一次，cause 为 null，另记 ci_watch_failed（不叫醒伙伴）', async () => {
  for (const [name, makeWorld, type, branch] of [
    ['main', () => makeMivoWorld({ mergeQueue: null, commitPullsFail: 502 }), 'main_ci_red', 'main'],
    ['integration', () => makeIntegrationWorld({ commitPullsFail: 502 }), 'integration_ci_red', MIVO_INT],
  ]) {
    const world = makeWorld()
    if (branch === 'main') world.mainRuns[MIVO_MAIN] = FAILED
    else world.integration[MIVO_INT].runs[MIVO_INT_SHA] = FAILED
    const env = await envWith(world)
    const first = (await tick(env)).events
    const red = ofType(first, type)
    assert.equal(red.length, 1, name)
    assert.equal(red[0].cause, null, name)
    const failed = ofType(first, 'ci_watch_failed')
    assert.deepEqual(failed.map((e) => e.branch), [branch], name)
    assert.match(failed[0].reason, /查弄红它的 PR 失败（.*502/, name)
    assert.ok(!toEventLines(first).some((line) => JSON.parse(line).type === 'ci_watch_failed'), name)
    assert.deepEqual(ofType((await tick(env)).events, type), [], `${name}：同一提交不再发`)
  }
})

// SC5：请求卡住（#54 单审第 1 轮）。GitHub 请求不返回时，找弄红它的 PR 不能把整轮拖到超时、连红灯事件一起丢掉

// 在假 GitHub 前面加一层：路径命中 hangOn 的请求一直挂着，直到调用方的中止信号触发
function hangingClient(env, hangOn) {
  const hung = []
  const fetchImpl = (url, init = {}) => {
    const { pathname } = new URL(url)
    if (!hangOn(pathname)) return env.fake.fetchImpl(url, init)
    hung.push({ pathname, hasSignal: Boolean(init.signal) })
    // 没带中止信号的请求在线上会一直挂着；测试里直接报错，不让用例跟着挂住
    if (!init.signal) return Promise.reject(new Error(`请求没带限时信号：${pathname}`))
    // 和真实 fetch 一样：信号已经中止的请求立刻失败
    if (init.signal.aborted) return Promise.reject(init.signal.reason)
    return new Promise((_, reject) => {
      const keepAlive = setTimeout(() => {}, 60_000)
      init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason) })
    })
  }
  return { client: createClient({ getToken: async () => 't', fetchImpl }), hung }
}
const greenVerdict = async () => ({ failed: [], unfinished: [], unknown: [], readError: null, empty: false })
// 只给签 JWT 用的一次性测试密钥
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
const mainRedEvent = { type: 'main_ci_red', repo: MIVO, branch: 'main', head: MIVO_MAIN, reason: 'main aaaaaaaa CI=failure' }

test('#53 SC5 读提交关联的 PR 卡住：到限时就放弃，红灯照发，cause 为 null，另记 ci_watch_failed', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(sha('b'), 'dave')
  addGreenMainCommit(world, sha('b'))
  const env = await makeMivoEnv({ world })
  const { client, hung } = hangingClient(env, (pathname) => pathname.endsWith('/pulls'))
  const started = Date.now()
  const out = await withRedCause({ client, repo: MIVO, events: [mainRedEvent], toCheckVerdict: greenVerdict, timeouts: { pullsTimeoutMs: 50 } })
  assert.ok(Date.now() - started < 5_000, '没有一直等下去')
  assert.deepEqual(out.map((e) => e.type), ['main_ci_red', 'ci_watch_failed'])
  assert.equal(out[0].cause, null)
  assert.deepEqual(hung, [{ pathname: `/repos/${MIVO}/commits/${MIVO_MAIN}/pulls`, hasSignal: true }])
})

test('#53 SC2 往回找的途中请求卡住：到限时就停在已确认的提交上（certain 为 false），照常查它的 PR', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const parent = sha('b')
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(parent, 'dave')
  world.commitPulls[MIVO_MAIN] = [mergedPull(11, 'bob', MIVO_MAIN)]
  const env = await makeMivoEnv({ world })
  // 父提交的 ci.yml 运行记录读不回来
  const { client, hung } = hangingClient(env, (pathname) => pathname.endsWith('/actions/workflows/ci.yml/runs'))
  const out = await withRedCause({ client, repo: MIVO, events: [mainRedEvent], toCheckVerdict: greenVerdict, timeouts: { walkTimeoutMs: 50 } })
  assert.deepEqual(out, [{ ...mainRedEvent, cause: { sha: MIVO_MAIN, pr: 11, author: 'bob', certain: false } }])
  assert.equal(hung.length, 1)
  assert.equal(hung[0].hasSignal, true)
})

test('#53 GitHub 客户端：带了 signal 就传给 fetch，不带就不传；别的事件原样放行', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(init)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createClient({ getToken: async () => 't', fetchImpl })
  const signal = AbortSignal.timeout(60_000)
  await client.request('GET', '/x', undefined, { signal })
  await client.request('GET', '/y')
  assert.equal(seen[0].signal, signal)
  assert.ok(!('signal' in seen[1]))
  const other = { type: 'lane_paused', repo: MIVO, reason: 'x' }
  assert.deepEqual(await withRedCause({ client, repo: MIVO, events: [other], toCheckVerdict: greenVerdict }), [other])
})

// #54 单审第 2 轮的 5 条

test('#53 SC2 父提交确认失败、但它的提交对象读不到：停在这个父提交上（它是最早确认变红的），不退回更新的提交', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const parent = sha('b')
  world.mainRuns[MIVO_MAIN] = FAILED
  world.mainRuns[parent] = FAILED
  world.commits[MIVO_MAIN] = commit(parent, 'late')
  world.commitPulls[MIVO_MAIN] = [mergedPull(11, 'late-author', MIVO_MAIN)]
  world.commitPulls[parent] = [mergedPull(10, 'alice', parent)]
  const env = await makeMivoEnv({ world })
  const { client } = hangingClient(env, (pathname) => pathname === `/repos/${MIVO}/commits/${parent}`)
  const out = await withRedCause({ client, repo: MIVO, events: [mainRedEvent], toCheckVerdict: greenVerdict, timeouts: { walkTimeoutMs: 50 } })
  assert.deepEqual(out, [{ ...mainRedEvent, cause: { sha: parent, pr: 10, author: 'alice', certain: false } }])
})

test('#53 SC5 提交对象没有 parents（异常应答）：按读失败处理，cause 为 null，不当成没有父提交', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = { message: 'Server Error', author: { login: 'dave' } }
  const env = await envWith(world)
  const events = (await tick(env)).events
  assert.deepEqual(ofType(events, 'main_ci_red').map((e) => e.cause), [null])
  assert.match(ofType(events, 'ci_watch_failed')[0].reason, /不是带 parents 的提交对象/)
})

test('#53 SC5 一轮里好几条红灯：共用一个总限时，用完以后剩下的直接按查不到处理，不逐条累加', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(sha('b'), 'dave')
  addGreenMainCommit(world, sha('b'))
  const env = await makeMivoEnv({ world })
  const { client } = hangingClient(env, (pathname) => pathname.endsWith('/pulls'))
  const reds = Array.from({ length: 6 }, () => ({ ...mainRedEvent }))
  const started = Date.now()
  // 每一步自己的限时故意放得很长：只有总限时能让它们停下
  const out = await withRedCause({ client, repo: MIVO, events: reds, toCheckVerdict: greenVerdict, budget: AbortSignal.timeout(150), timeouts: { walkTimeoutMs: 60_000, pullsTimeoutMs: 60_000 } })
  assert.ok(Date.now() - started < 5_000, `6 条一共用了 ${Date.now() - started} ms`)
  assert.deepEqual(ofType(out, 'main_ci_red').map((e) => e.cause), [null, null, null, null, null, null])
  assert.equal(ofType(out, 'ci_watch_failed').length, 6)
})

test('#53 换令牌的请求也跟着限时：客户端把 signal 交给令牌提供者，令牌提供者把它交给 fetch', async () => {
  // 令牌提供者卡住，直到信号触发
  const stuck = ({ signal } = {}) => new Promise((_, reject) => {
    if (!signal) return reject(new Error('换令牌没带限时信号'))
    // AbortSignal.timeout 的定时器不占事件循环，另挂一个定时器占住，中止时清掉（不占住的话用例会被判成「事件循环已空」）
    const keepAlive = setTimeout(() => {}, 60_000)
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason) })
  })
  const client = createClient({ getToken: stuck, fetchImpl: async () => { throw new Error('不该走到请求这一步') } })
  await assert.rejects(client.request('GET', '/x', undefined, { signal: AbortSignal.timeout(50) }), { name: 'TimeoutError' })
  const seen = []
  const getToken = createTokenProvider({ appId: 1, installationId: 2, privateKey: KEY, fetchImpl: async (url, init) => {
    seen.push(init)
    return new Response(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201, headers: { 'content-type': 'application/json' } })
  } })
  const signal = AbortSignal.timeout(60_000)
  assert.equal(await getToken({ signal }), 't')
  assert.equal(seen[0].signal, signal)
  assert.equal(await getToken(), 't', '缓存的令牌直接返回，不带参数照常能用')
  assert.equal(seen.length, 1)
})
