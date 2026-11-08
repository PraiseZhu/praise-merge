// #32：Mivo 目标分支当前提交上的全部检查都绿才合或追分支；有一项失败或还在跑就暂停车道，转全绿的那一轮就恢复
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, seedMivoItem, greenBranchChecks, MIVO, MIVO_MAIN, MIVO_HEAD, MIVO_INT, MIVO_INT_SHA } from './helpers/fake-mivo.mjs'

const tick = (env) => runTick({ ...env, now: Date.now() })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const lane = (env) => env.store.loadLanes()[MIVO]
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))
const types = (events) => events.map((e) => e.type)
const run = (id, name, status = 'completed', conclusion = status === 'completed' ? 'success' : null) => ({ id, name, status, conclusion })
const CODEQL = 'Analyze (javascript-typescript)'

// main 当前提交上的 check run：默认的全绿集合再加几项
const withMainChecks = (world, ...extra) => {
  world.branchChecks[MIVO_MAIN] = [...greenBranchChecks(), ...extra]
  return world
}
const noQueue = () => makeMivoWorld({ mergeQueue: null })
const behind = () => {
  const world = makeMivoWorld({ mergeQueue: null, behindBy: 3 })
  world.prs[1].gql.mergeStateStatus = 'BEHIND'
  return world
}

async function pausedEnv(world) {
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  const { events } = await tick(env)
  return { env, events }
}

function assertPaused({ env, events }, reason) {
  assert.deepEqual(env.fake.writes(), [])
  assert.equal(item(env).status, 'queued')
  assert.match(lane(env).paused, reason)
  assert.ok(events.some((e) => e.type === 'lane_paused' && reason.test(e.reason)), '发 lane_paused，原因和车道状态一致')
  assert.equal(lane(env).frozen, undefined)
}

// SC1

for (const [name, makeWorld] of [['没开队列（直接合并）', noQueue], ['BEHIND 且落后（update-branch）', behind], ['开着合并队列（入队）', () => makeMivoWorld()]]) {
  test(`#32 SC1 main 的 ci.yml 成功但 CodeQL 最新一次失败：车道暂停，不合并、不追分支、不入队（${name}）`, async () => {
    const result = await pausedEnv(withMainChecks(makeWorld(), run(910, CODEQL, 'completed', 'failure')))
    assertPaused(result, /^main_checks_not_green: aaaaaaaa Analyze \(javascript-typescript\)=failure$/)
  })
}

test('#32 SC1 失败的排在未完成的前面，超过 10 项只列 10 项并写总数', async () => {
  const pending = Array.from({ length: 11 }, (_, i) => run(950 + i, `job ${String(i).padStart(2, '0')}`, 'queued'))
  const result = await pausedEnv(withMainChecks(noQueue(), ...pending, run(990, 'zz CodeQL', 'completed', 'cancelled')))
  assertPaused(result, /^main_checks_not_green: aaaaaaaa zz CodeQL=cancelled, job 00=queued, .*job 08=queued 等 12 项$/)
})

// SC2

test('#32 SC2 同名检查先失败、重跑后最新一次（id 最大）成功：算绿，照常合并', async () => {
  // 接口返回顺序和 id 顺序相反：按 id 取最新，不按返回顺序
  const env = await makeMivoEnv({ world: withMainChecks(noQueue(), run(920, CODEQL), run(910, CODEQL, 'completed', 'failure')) })
  seedMivoItem(env.store)
  await tick(env)
  assert.deepEqual(directMerges(env).map((c) => c.body), [{ sha: MIVO_HEAD, merge_method: 'squash' }])
  assert.equal(item(env).status, 'merged')
  assert.equal(lane(env)?.paused, undefined)
})

test('#32 SC2 同名检查最新一次（id 最大）失败、旧的一次成功：暂停', async () => {
  const result = await pausedEnv(withMainChecks(noQueue(), run(920, CODEQL, 'completed', 'failure'), run(910, CODEQL)))
  assertPaused(result, /^main_checks_not_green: aaaaaaaa Analyze \(javascript-typescript\)=failure$/)
})

// 同名检查可能来自不同 App（例如 CodeQL 默认配置和自己写的工作流）：按 App 分开取最新一次，别的 App 的成功盖不掉这个 App 的失败
const crossApp = () => [{ ...run(910, CODEQL, 'completed', 'failure'), app: { id: 101 } }, { ...run(920, CODEQL), app: { id: 202 } }]

test('#32 SC2 同名检查来自两个 App：一个失败（id 小）、另一个成功（id 大）：暂停不合', async () => {
  const result = await pausedEnv(withMainChecks(noQueue(), ...crossApp()))
  assertPaused(result, /^main_checks_not_green: aaaaaaaa Analyze \(javascript-typescript\)=failure$/)
  assert.equal(directMerges(result.env).length, 0)
})

test('#32 SC2 同一个 App 的同名检查重跑：仍按 id 取最新一次，重跑成功照常合', async () => {
  const env = await makeMivoEnv({ world: withMainChecks(noQueue(), { ...run(920, CODEQL), app: { id: 101 } }, { ...run(910, CODEQL, 'completed', 'failure'), app: { id: 101 } }) })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(item(env).status, 'merged')
})

for (const status of ['in_progress', 'queued']) {
  test(`#32 SC2 有检查还是 ${status}：暂停`, async () => {
    const result = await pausedEnv(withMainChecks(noQueue(), run(910, CODEQL, status)))
    assertPaused(result, new RegExp(`^main_checks_not_green: aaaaaaaa Analyze \\(javascript-typescript\\)=${status}$`))
  })
}

// SC3

for (const [name, statuses, reason] of [
  ['有一条 failure', [{ id: 1, context: 'ci/legacy', state: 'failure' }, { id: 2, context: 'deploy/preview', state: 'success' }], /^main_checks_not_green: aaaaaaaa ci\/legacy=failure$/],
  ['有一条还是 pending', [{ id: 1, context: 'ci/legacy', state: 'pending' }], /^main_checks_not_green: aaaaaaaa ci\/legacy=pending$/],
  ['有一条 error', [{ id: 1, context: 'ci/legacy', state: 'error' }], /^main_checks_not_green: aaaaaaaa ci\/legacy=error$/],
]) {
  test(`#32 SC3 commit status 合并状态不是 success：暂停（${name}）`, async () => {
    const world = noQueue()
    world.statuses[MIVO_MAIN] = statuses
    assertPaused(await pausedEnv(world), reason)
  })
}

test('#32 SC3 commit status 先失败后成功（合并状态 success）：不因此暂停，照常合并', async () => {
  const world = noQueue()
  world.statuses[MIVO_MAIN] = [{ id: 1, context: 'ci/legacy', state: 'failure' }, { id: 2, context: 'ci/legacy', state: 'success' }]
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(item(env).status, 'merged')
})

test('#32 SC3 没有 commit status 条目（GitHub 这时给的合并状态是 pending）：不因此暂停，照常合并', async () => {
  const env = await makeMivoEnv({ world: noQueue() })
  seedMivoItem(env.store)
  await tick(env)
  const status = await env.client.request('GET', `/repos/${MIVO}/commits/${MIVO_MAIN}/status`)
  assert.deepEqual([status.state, status.total_count], ['pending', 0])
  assert.equal(item(env).status, 'merged')
  assert.equal(lane(env)?.paused, undefined)
})

// SC4

test('#32 SC4 连续多轮：暂停只叫醒一次；原因变了再发一次；全绿那一轮发 lane_resumed 并照常合并', async () => {
  const world = withMainChecks(noQueue(), run(910, CODEQL, 'completed', 'failure'))
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)

  assert.deepEqual(types((await tick(env)).events), ['lane_paused'])
  assert.deepEqual(types((await tick(env)).events), [], '原因不变：不重复发 lane_paused')
  assert.deepEqual(types((await tick(env)).events), [])

  withMainChecks(world, run(910, CODEQL, 'completed', 'failure'), run(911, 'Analyze (python)', 'in_progress'))
  const changed = (await tick(env)).events
  assert.deepEqual(types(changed), ['lane_paused'])
  assert.match(changed[0].reason, /Analyze \(javascript-typescript\)=failure, Analyze \(python\)=in_progress$/)

  // CodeQL 重跑成功：转全绿的这一轮就恢复，同一轮合并
  withMainChecks(world, run(910, CODEQL, 'completed', 'failure'), run(920, CODEQL))
  const resumed = (await tick(env)).events
  assert.deepEqual(types(resumed).slice(0, 2), ['lane_resumed', 'merged'])
  assert.equal(lane(env).paused, undefined)
  assert.equal(directMerges(env).length, 1)
  assert.equal(item(env).status, 'merged')
})

test('#32 SC4 ci.yml 还在跑时原因保持 main_ci_not_success；ci.yml 成功后才看全部检查', async () => {
  const world = withMainChecks(noQueue(), run(910, CODEQL, 'in_progress'))
  world.mainRuns[MIVO_MAIN] = { status: 'in_progress', conclusion: null }
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  await tick(env)
  assert.match(lane(env).paused, /^main_ci_not_success: aaaaaaaa in_progress\/null$/)
  world.mainRuns[MIVO_MAIN] = { status: 'completed', conclusion: 'success' }
  const { events } = await tick(env)
  assert.deepEqual(types(events), ['lane_paused'])
  assert.match(lane(env).paused, /^main_checks_not_green: aaaaaaaa Analyze \(javascript-typescript\)=in_progress$/)
})

// SC5

test('#32 SC5 读 check run 失败（502）：按不满足处理，暂停不合并', async () => {
  const world = noQueue()
  world.checkRunsFail[MIVO_MAIN] = 502
  assertPaused(await pausedEnv(world), /^main_checks_not_green: aaaaaaaa 检查读取失败（GET \/repos\/xindong\/mivo-canvas-plugin\/commits\/a{40}\/check-runs\?per_page=100&page=1 -> 502 fake: check run 读失败）$/)
})

const manyGreen = (n) => Array.from({ length: n }, (_, i) => run(2000 + i, `job ${i}`))

test('#32 SC5 check run 分页读不完（GitHub 只给第 1 页）：按不满足处理，暂停不合并', async () => {
  const world = noQueue()
  world.branchChecks[MIVO_MAIN] = manyGreen(150)
  world.checkRunPageLimit = 1
  assertPaused(await pausedEnv(world), /^main_checks_not_green: aaaaaaaa check run 读不全：共 150 个，只读到 100 个$/)
})

test('#32 SC5 check run 超过一页：读完全部分页，第 2 页上的失败也算', async () => {
  const world = noQueue()
  world.branchChecks[MIVO_MAIN] = [...manyGreen(149), run(9999, CODEQL, 'completed', 'failure')]
  assertPaused(await pausedEnv(world), /^main_checks_not_green: aaaaaaaa Analyze \(javascript-typescript\)=failure$/)
})

test('#32 SC5 check run 超过一页且全绿：照常合并', async () => {
  const world = noQueue()
  world.branchChecks[MIVO_MAIN] = manyGreen(150)
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(item(env).status, 'merged')
})

test('#32 main 提交上一个 check run 都没有：不算全绿，暂停', async () => {
  const world = noQueue()
  world.branchChecks[MIVO_MAIN] = []
  assertPaused(await pausedEnv(world), /^main_checks_not_green: aaaaaaaa no_check_runs: 还没有任何 push 触发的 check run$/)
})

// SC6

test('#32 SC6 集成分支头上有检查失败：合进它的 PR 留在队列，原因带分支名；不暂停车道，同一轮 main 的 PR 照常合', async () => {
  const world = makeIntegrationWorld()
  world.branchChecks[MIVO_INT_SHA] = [...greenBranchChecks(), run(910, CODEQL, 'completed', 'failure')]
  world.checks = [...world.checks, { id: 99, name: 'review-pr', status: 'completed', conclusion: 'success', app: { id: 15368 } }]
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store, 1, { base: MIVO_INT })
  seedMivoItem(env.store, 2)
  const { events } = await tick(env)
  assert.equal(item(env, 1).status, 'queued')
  assert.equal(item(env, 1).reason, `base_checks_not_green: ${MIVO_INT} 99999999 Analyze (javascript-typescript)=failure`)
  assert.deepEqual(directMerges(env).map((c) => c.path), [`/repos/${MIVO}/pulls/2/merge`])
  assert.equal(lane(env).paused, undefined)
  assert.ok(!events.some((e) => e.type === 'lane_paused'))
})

for (const [name, patch, reason] of [
  ['有检查还在跑', (w) => { w.branchChecks[MIVO_INT_SHA] = [...greenBranchChecks(), run(910, CODEQL, 'in_progress')] }, `${CODEQL}=in_progress`],
  ['commit status 失败', (w) => { w.statuses[MIVO_INT_SHA] = [{ id: 1, context: 'ci/legacy', state: 'failure' }] }, 'ci/legacy=failure'],
  ['读 check run 失败', (w) => { w.checkRunsFail[MIVO_INT_SHA] = 502 }, '检查读取失败（'],
  ['同名检查来自两个 App、失败的那个 id 小', (w) => { w.branchChecks[MIVO_INT_SHA] = [...greenBranchChecks(), ...crossApp()] }, `${CODEQL}=failure`],
]) {
  test(`#32 SC6 集成分支用同一条规则：${name}就不合，原因带分支名`, async () => {
    const world = makeIntegrationWorld()
    patch(world)
    const env = await makeMivoEnv({ world })
    seedMivoItem(env.store, 1, { base: MIVO_INT })
    await tick(env)
    assert.deepEqual(env.fake.writes(), [])
    assert.ok(item(env).reason.startsWith(`base_checks_not_green: ${MIVO_INT} 99999999 ${reason}`), item(env).reason)
  })
}
