// #4：Mivo 车道
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTick } from '../src/tick.mjs'
import { makeMivoEnv, makeMivoWorld, seedMivoItem, MIVO, MIVO_CHECKS, MIVO_HEAD } from './helpers/fake-mivo.mjs'

const DAY = 24 * 60 * 60 * 1000
const tick = (env, now = Date.now()) => runTick({ ...env, now })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const enqueues = (env) => env.fake.calls.filter((c) => c.path === '/graphql' && c.body.query.includes('enqueuePullRequest'))
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))

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
  ['main 最近一次 CI 不是 success', makeMivoWorld({ mainRun: { status: 'completed', conclusion: 'failure' } }), /main_ci_not_success: completed\/failure/],
  ['main 没开合并队列', makeMivoWorld({ mergeQueue: null }), /merge_queue_disabled/],
]) {
  test(`SC1 车道暂停、不入队：${name}`, async () => {
    const env = await makeMivoEnv({ world })
    seedMivoItem(env.store)
    const { events } = await tick(env)
    assert.equal(enqueues(env).length, 0)
    assert.match(env.store.loadLanes()[MIVO].paused, reason)
    assert.ok(events.some((e) => e.type === 'lane_paused'))
    assert.equal(env.store.loadLanes()[MIVO].frozen, undefined)
  })
}

test('SC2 全部满足：只发一次 enqueuePullRequest，expectedHeadOid 等于 head；没有任何直接合并请求', async () => {
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
