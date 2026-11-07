// #4：Mivo 车道
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTick } from '../src/tick.mjs'
import { makeMivoEnv, makeMivoWorld, seedMivoItem, MIVO, MIVO_CHECKS, MIVO_HEAD, MIVO_MAIN } from './helpers/fake-mivo.mjs'

const DAY = 24 * 60 * 60 * 1000
const tick = (env, now = Date.now()) => runTick({ ...env, now })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const enqueues = (env) => env.fake.calls.filter((c) => c.path === '/graphql' && c.body.query.includes('enqueuePullRequest'))
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))
const updateBranches = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/update-branch$/.test(c.path))
const noQueue = (overrides = {}) => makeMivoWorld({ mergeQueue: null, ...overrides })
// GitHub 要求先同步：开了 strict 的分支上落后的 PR 是 BEHIND
const asBehind = (world) => {
  world.prs[1].gql.mergeStateStatus = 'BEHIND'
  return world
}

function withPr(n, patch) {
  const world = makeMivoWorld()
  Object.assign(world.prs[n].rest, patch.rest ?? {})
  Object.assign(world.prs[n].gql, patch.gql ?? {})
  return world
}

const cases = [
  ['作者不是 PraiseZhu', withPr(1, { rest: { user: { login: 'someone' } } }), /author: 期望 PraiseZhu，实际 someone/],
  ['Draft', withPr(1, { rest: { draft: true } }), /not_draft/],
  ['base 不是 main', withPr(1, { rest: { base: { ref: 'integration/x' } } }), /base: 期望 main，实际 integration\/x/],
  ['必需检查有一项失败', makeMivoWorld({ checks: makeMivoWorld().checks.map((c) => (c.name === 'verify' ? { ...c, conclusion: 'failure' } : c)) }), /verify=failure/],
  ['review-pr 不是 integration 15368 写的', makeMivoWorld({ checks: makeMivoWorld().checks.map((c) => (c.name === 'review-pr' ? { ...c, app: { id: 999 } } : c)) }), /review-pr: 写入方不是 integration 15368/],
  ['有未解决讨论', makeMivoWorld({ threads: [{ isResolved: false }] }), /未解决讨论 1 条/],
  ['App 看到的 mergeStateStatus 不是 CLEAN', withPr(1, { gql: { mergeStateStatus: 'BLOCKED' } }), /merge_state: BLOCKED/],
]
for (const [name, world, reason] of cases) {
  test(`SC1 门禁单项不满足不入队：${name}`, async () => {
    const env = await makeMivoEnv({ world })
    seedMivoItem(env.store)
    await tick(env)
    assert.equal(enqueues(env).length, 0)
    assert.match(item(env).reason, reason)
  })
}

test('SC1 授权过期不入队', async () => {
  const env = await makeMivoEnv()
  seedMivoItem(env.store, 1, { authorizedAt: new Date(Date.now() - 7 * DAY - 60_000).toISOString() })
  await tick(env)
  assert.equal(item(env).status, 'expired')
  assert.equal(enqueues(env).length, 0)
})

for (const [name, world, reason] of [
  ['main 当前 head 的 CI 失败', noQueue({ mainRuns: { [MIVO_MAIN]: { status: 'completed', conclusion: 'failure' } } }), /main_ci_not_success: aaaaaaaa completed\/failure/],
  ['main 当前 head 的 CI 还在跑', noQueue({ mainRuns: { [MIVO_MAIN]: { status: 'in_progress', conclusion: null } } }), /main_ci_not_success: aaaaaaaa in_progress\/null/],
  ['main 刚有新提交、还没有 CI run（旧提交的 success 不算）', noQueue({ mainSha: 'b'.repeat(40) }), /main_ci_not_success: bbbbbbbb no_run/],
]) {
  test(`#14 SC4 车道暂停、不合并也不追 main：${name}`, async () => {
    const env = await makeMivoEnv({ world })
    seedMivoItem(env.store)
    const { events } = await tick(env)
    assert.deepEqual(env.fake.writes(), [])
    assert.match(env.store.loadLanes()[MIVO].paused, reason)
    assert.ok(events.some((e) => e.type === 'lane_paused'))
    assert.equal(env.store.loadLanes()[MIVO].frozen, undefined)
  })
}

test('SC2（#14 SC5）main 开着队列、全部满足：只发一次 enqueuePullRequest，expectedHeadOid 等于 head；没有任何直接合并请求', async () => {
  const env = await makeMivoEnv()
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(enqueues(env).length, 1)
  assert.deepEqual(enqueues(env)[0].body.variables, { id: 'PR_1', oid: MIVO_HEAD })
  await tick(env) // 已在队列里：不重复入队
  assert.equal(enqueues(env).length, 1)
  assert.match(item(env).reason, /in_merge_queue: QUEUED/)
  assert.equal(directMerges(env).length, 0)
})

test('SC3 规则集被改松（少了 review-pr）：冻结车道，reason 为 required_checks_weakened，不入队', async () => {
  const world = makeMivoWorld()
  world.rules[0].parameters.required_status_checks = world.rules[0].parameters.required_status_checks.filter((c) => c.context !== 'review-pr')
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  await tick(env)
  assert.match(env.store.loadLanes()[MIVO].frozen.reason, /required_checks_weakened: 缺少 review-pr/)
  assert.equal(enqueues(env).length, 0)
})

test('SC3 必需检查的 integration 被换掉也算改松', async () => {
  const world = makeMivoWorld()
  world.rules[0].parameters.required_status_checks = MIVO_CHECKS.map((context) => ({ context, integration_id: context === 'verify' ? null : 15368 }))
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  await tick(env)
  assert.match(env.store.loadLanes()[MIVO].frozen.reason, /integration 不是 15368: verify/)
})

test('SC4 依赖：A 已入队未合入时 B 不入队；A 合入后下一轮 B 才入队', async () => {
  const env = await makeMivoEnv()
  seedMivoItem(env.store, 1)
  seedMivoItem(env.store, 2, { after: [`${MIVO}#1`] })
  await tick(env)
  assert.deepEqual(enqueues(env).map((c) => c.body.variables.id), ['PR_1'])
  await tick(env)
  assert.equal(enqueues(env).length, 1)

  Object.assign(env.world.prs[1].rest, { merged: true, state: 'closed' })
  await tick(env)
  assert.equal(item(env, 1).status, 'merged')
  await tick(env)
  assert.deepEqual(enqueues(env).map((c) => c.body.variables.id), ['PR_1', 'PR_2'])
})

test('SC4、SC5 A 被移出队列：A 变成 dequeued、不再入队，B 变成 blocked_by_dependency', async () => {
  const env = await makeMivoEnv()
  seedMivoItem(env.store, 1)
  seedMivoItem(env.store, 2, { after: [`${MIVO}#1`] })
  await tick(env)
  env.world.prs[1].gql.mergeQueueEntry = null // 组合 CI 失败，被队列踢出
  const { events } = await tick(env)
  assert.equal(item(env, 1).status, 'dequeued')
  assert.ok(events.some((e) => e.type === 'dequeued'))
  await tick(env)
  assert.equal(item(env, 2).status, 'blocked_by_dependency')
  assert.equal(enqueues(env).length, 1)
})

test('SC6 影子模式：只记录 would_enqueue，写请求（含 GraphQL mutation）数为 0', async () => {
  const env = await makeMivoEnv({ shadow: true })
  seedMivoItem(env.store)
  const { events } = await tick(env)
  assert.deepEqual(events.map((e) => e.type), ['would_enqueue'])
  assert.deepEqual(env.fake.writes(), [])
})

test('SC7 占位实现已删除；车道注册表能加载 mivo 车道', async () => {
  const lanesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lanes')
  assert.equal(existsSync(join(lanesDir, 'mivo-stub.mjs')), false)
  const env = await makeMivoEnv()
  assert.ok(env.lanes.get('mivo').beforeItems)
})

test('#14 SC1 没开队列、门禁全过、不落后 main：只发一次直接合并，sha 锁定 head、squash；没有 enqueue', async () => {
  const env = await makeMivoEnv({ world: noQueue() })
  seedMivoItem(env.store)
  const { events } = await tick(env)
  assert.equal(directMerges(env).length, 1)
  assert.deepEqual(directMerges(env)[0].body, { sha: MIVO_HEAD, merge_method: 'squash' })
  assert.equal(enqueues(env).length, 0)
  assert.equal(item(env).status, 'merged')
  assert.ok(events.some((e) => e.type === 'merged' && e.mergeSha === 'f'.repeat(40)))
})

test('#14 SC1 一轮只合一个：A 合入后本轮车道停下，B 留到下一轮', async () => {
  const env = await makeMivoEnv({ world: noQueue() })
  seedMivoItem(env.store, 1)
  seedMivoItem(env.store, 2)
  await tick(env)
  assert.equal(directMerges(env).length, 1)
  assert.equal(item(env, 2).status, 'queued')
})

test('#26 SC1 落后 main 但 GitHub 判定 CLEAN：直接合并，sha 锁定当前 head；不发 update-branch，也不读落后数', async () => {
  const env = await makeMivoEnv({ world: noQueue({ behindBy: 3 }) })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(updateBranches(env).length, 0)
  assert.deepEqual(directMerges(env).map((c) => c.body), [{ sha: MIVO_HEAD, merge_method: 'squash' }])
  assert.equal(item(env).status, 'merged')
  assert.equal(env.fake.calls.filter((c) => c.path.includes('/compare/')).length, 0)
  // 合并后兜底照旧：父提交是检查时的 main，不冻结
  assert.equal(env.store.loadLanes()[MIVO]?.frozen, undefined)
})

test('#14 SC2（#26 SC2）BEHIND 且落后 main：不合并，update-branch 锁 expected_head_sha；新 head 检查没重新通过前不合', async () => {
  const env = await makeMivoEnv({ world: asBehind(noQueue({ behindBy: 3 })) })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(directMerges(env).length, 0)
  assert.equal(updateBranches(env).length, 1)
  assert.deepEqual(updateBranches(env)[0].body, { expected_head_sha: MIVO_HEAD })
  assert.match(item(env).reason, /update_branch_requested \| up_to_date: 落后 main 3 个提交/)

  // 追完 main：head 换了、不再落后，但新 head 上 CI 和审查机还在跑
  const newHead = 'e'.repeat(40)
  env.world.prs[1].rest.head = { sha: newHead }
  env.world.prs[1].gql.mergeStateStatus = 'CLEAN'
  env.world.behindBy = 0
  env.world.checks = env.world.checks.map((c) => (c.name === 'review-pr' || c.name === 'verify' ? { ...c, status: 'in_progress', conclusion: null } : c))
  await tick(env)
  assert.equal(directMerges(env).length, 0)
  assert.match(item(env).reason, /required_checks: verify=.*review-pr=/)

  env.world.checks = makeMivoWorld().checks
  await tick(env)
  assert.equal(directMerges(env).length, 1)
  assert.deepEqual(directMerges(env)[0].body, { sha: newHead, merge_method: 'squash' })
})

for (const status of [405, 409, 422]) {
  test(`#14 SC3 GitHub 拒绝合并（${status}）：记 merge_refused，条目保持待处理，本轮停下`, async () => {
    const env = await makeMivoEnv({ world: noQueue({ mergeResponse: status }) })
    seedMivoItem(env.store, 1)
    seedMivoItem(env.store, 2)
    const { events } = await tick(env)
    assert.ok(events.some((e) => e.type === 'merge_refused'))
    assert.equal(item(env).status, 'queued')
    assert.match(item(env).reason, /merge_refused/)
    assert.equal(directMerges(env).length, 1)
  })
}

for (const [name, world, type] of [
  ['不落后 main → would_merge', noQueue(), 'would_merge'],
  ['落后 main 但 CLEAN → would_merge', noQueue({ behindBy: 2 }), 'would_merge'],
  ['BEHIND 且落后 main → would_update_branch', asBehind(noQueue({ behindBy: 2 })), 'would_update_branch'],
]) {
  test(`#14 SC6 影子模式没开队列：${name}，写请求数为 0`, async () => {
    const env = await makeMivoEnv({ world, shadow: true })
    seedMivoItem(env.store)
    const { events } = await tick(env)
    assert.deepEqual(events.map((e) => e.type), [type])
    assert.deepEqual(env.fake.writes(), [])
  })
}

test('#14 BEHIND 时落后判断对着钉住的 main 提交比，不对着会移动的分支名', async () => {
  const env = await makeMivoEnv({ world: asBehind(noQueue({ behindBy: 1 })) })
  seedMivoItem(env.store)
  await tick(env)
  const compares = env.fake.calls.filter((c) => c.path.includes('/compare/'))
  assert.deepEqual(compares.map((c) => c.path), [`/repos/${MIVO}/compare/${MIVO_MAIN}...${MIVO_HEAD}`])
})

test('#14 检查到合并之间 main 被别人推进：照记 merged，同时冻结车道，下一轮不再合', async () => {
  const env = await makeMivoEnv({ world: noQueue({ mergeParent: 'c'.repeat(40) }) })
  seedMivoItem(env.store, 1)
  seedMivoItem(env.store, 2)
  const { events } = await tick(env)
  assert.equal(item(env, 1).status, 'merged')
  assert.ok(events.some((e) => e.type === 'merged'))
  assert.match(env.store.loadLanes()[MIVO].frozen.reason, /merged_on_moved_main: #1 合并时 main 已不是检查时的 aaaaaaaa（合并提交的父提交 cccccccc）/)
  assert.ok(events.some((e) => e.type === 'lane_frozen'))
  await tick(env)
  assert.equal(directMerges(env).length, 1)
  assert.equal(item(env, 2).status, 'queued')
})

test('#14 合并提交的父提交就是检查时的 main：不冻结', async () => {
  const env = await makeMivoEnv({ world: noQueue() })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(item(env).status, 'merged')
  assert.equal(env.store.loadLanes()[MIVO]?.frozen, undefined)
})

test('#14 合并成功但读不到合并提交：照记 merged，冻结车道（merge_parent_unverified），不抛错', async () => {
  const env = await makeMivoEnv({ world: noQueue({ commitReadFails: true }) })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(item(env).status, 'merged')
  assert.match(env.store.loadLanes()[MIVO].frozen.reason, /merge_parent_unverified: #1 已合入 ffffffff/)
})

test('#14 落后判断用 beforeItems 已确认 CI 的 main 提交：一轮只读一次 main', async () => {
  const env = await makeMivoEnv({ world: noQueue() })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(env.fake.calls.filter((c) => c.path === `/repos/${MIVO}/branches/main`).length, 1)
  assert.equal(directMerges(env).length, 1)
})

test('#14 App 看到 BEHIND 且确实落后：走 update-branch，不当成门禁失败', async () => {
  const world = noQueue({ behindBy: 2 })
  world.prs[1].gql.mergeStateStatus = 'BEHIND'
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(updateBranches(env).length, 1)
  assert.equal(directMerges(env).length, 0)
})

test('#14 App 看到 BEHIND 但对钉住的 main 不落后（main 在本轮检查后又前进）：不合不追，下一轮重判', async () => {
  const world = noQueue()
  world.prs[1].gql.mergeStateStatus = 'BEHIND'
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store)
  await tick(env)
  assert.deepEqual(env.fake.writes(), [])
  assert.match(item(env).reason, /merge_state: BEHIND（main 已越过本轮检查的 aaaaaaaa）/)
})

test('#14 合并请求结果不确定（502）：冻结车道（merge_result_unknown），不抛错，条目保持待处理', async () => {
  const env = await makeMivoEnv({ world: noQueue({ mergeResponse: 502 }) })
  seedMivoItem(env.store)
  const { events } = await tick(env)
  assert.equal(item(env).status, 'queued')
  assert.match(env.store.loadLanes()[MIVO].frozen.reason, /merge_result_unknown: #1/)
  assert.ok(events.some((e) => e.type === 'lane_frozen'))
})

test('#14 队列里的 PR 已被别人合并：记 merged 后本轮停下，不拿旧 main 去合下一个', async () => {
  const env = await makeMivoEnv({ world: noQueue() })
  seedMivoItem(env.store, 1)
  seedMivoItem(env.store, 2)
  Object.assign(env.world.prs[1].rest, { merged: true, state: 'closed' })
  await tick(env)
  assert.equal(item(env, 1).status, 'merged')
  assert.equal(directMerges(env).length, 0)
  assert.equal(item(env, 2).status, 'queued')
})
