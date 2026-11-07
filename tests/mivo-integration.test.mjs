// #20：Mivo 车道合进 integration/* 集成分支；其他非 main 目标接单即拒收
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runTick } from '../src/tick.mjs'
import { enqueueRequest } from '../src/enqueue.mjs'
import { SCHEMA } from '../src/request.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, seedMivoItem, MIVO, MIVO_HEAD, MIVO_MAIN, MIVO_INT, MIVO_INT_SHA } from './helpers/fake-mivo.mjs'

const tick = (env) => runTick({ ...env, now: Date.now() })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))
const updateBranches = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/update-branch$/.test(c.path))
const compares = (env) => env.fake.calls.filter((c) => c.path.includes('/compare/')).map((c) => c.path)
const lane = (env) => env.store.loadLanes()[MIVO]
const seedInt = (env, n = 1, overrides = {}) => seedMivoItem(env.store, n, { base: MIVO_INT, ...overrides })
const readLog = (env) => readdirSync(join(env.store.dir, 'logs')).flatMap((f) => readFileSync(join(env.store.dir, 'logs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))

// enqueue

async function enqueueWithBases(bases) {
  const world = makeMivoWorld()
  bases.forEach((ref, i) => {
    const n = i + 1
    world.prs[n] ??= { rest: { ...world.prs[1].rest, number: n }, gql: { ...world.prs[1].gql, id: `PR_${n}` } }
    world.prs[n].rest = { ...world.prs[n].rest, base: { ref } }
  })
  const env = await makeMivoEnv({ world })
  const request = {
    schema: SCHEMA, session_id: 's1', authorized_at: new Date().toISOString(), authorization_text: '合并',
    prs: bases.map((_, i) => ({ repo: MIVO, number: i + 1, head_sha_at_auth: MIVO_HEAD })),
  }
  const result = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request })
  return { env, result, reasons: Object.fromEntries(result.rejected.map((r) => [r.id, r.reason])) }
}

test('SC1 目标是 release/x 的 Mivo PR 接单即拒收：原因含期望值和实际值，事件日志写 rejected，不进队列', async () => {
  const { env, result, reasons } = await enqueueWithBases(['release/x'])
  assert.deepEqual(result.accepted, [])
  assert.equal(reasons[`${MIVO}#1`], 'base 期望 main 或 integration/*，实际 release/x')
  assert.equal(env.store.loadQueue().items.length, 0)
  const logged = readLog(env).find((r) => r.type === 'request_accepted')
  assert.deepEqual(logged.rejected, [{ id: `${MIVO}#1`, reason: 'base 期望 main 或 integration/*，实际 release/x' }])
})

test('SC1 integration 下再深一层的分支（规则集管不到）也拒收', async () => {
  const { reasons } = await enqueueWithBases(['integration/a/b'])
  assert.match(reasons[`${MIVO}#1`], /实际 integration\/a\/b/)
})

test('SC1 合进 main 和 integration/* 的照常收下，并记下授权时的目标分支', async () => {
  const { env, result } = await enqueueWithBases(['main', MIVO_INT])
  assert.deepEqual(result.accepted, [`${MIVO}#1`, `${MIVO}#2`])
  assert.deepEqual(env.store.loadQueue().items.map((it) => it.base), ['main', MIVO_INT])
})

// process：合并

test('SC2 集成分支门禁全过：只发一次直接合并，sha 锁定当前 head，用 merge；父提交是集成分支头 + head，不冻结', async () => {
  const env = await makeMivoEnv({ world: makeIntegrationWorld() })
  seedInt(env)
  const { events } = await tick(env)
  assert.equal(directMerges(env).length, 1)
  assert.equal(directMerges(env)[0].path, `/repos/${MIVO}/pulls/1/merge`)
  assert.deepEqual(directMerges(env)[0].body, { sha: MIVO_HEAD, merge_method: 'merge' })
  assert.equal(item(env).status, 'merged')
  assert.ok(events.some((e) => e.type === 'merged'))
  assert.equal(lane(env).frozen, undefined)
  // 规则按集成分支读，不是 main
  assert.ok(env.fake.calls.some((c) => c.path === `/repos/${MIVO}/rules/branches/integration%2Fx`))
})

const sc3 = [
  ['review-pr (integration) 缺失（只有 main 的 review-pr）', makeIntegrationWorld({ checks: makeMivoWorld().checks }), /review-pr \(integration\)=missing/],
  ['review-pr (integration) 失败', makeIntegrationWorld({ checks: makeIntegrationWorld().checks.map((c) => (c.name === 'review-pr (integration)' ? { ...c, conclusion: 'failure' } : c)) }), /review-pr \(integration\)=failure/],
  ['review-pr (integration) 不是 integration 15368 写的', makeIntegrationWorld({ checks: makeIntegrationWorld().checks.map((c) => (c.name === 'review-pr (integration)' ? { ...c, app: { id: 999 } } : c)) }), /review-pr \(integration\): 写入方不是 integration 15368/],
  ['其他必需检查没过', makeIntegrationWorld({ checks: makeIntegrationWorld().checks.map((c) => (c.name === 'verify' ? { ...c, status: 'in_progress', conclusion: null } : c)) }), /verify=in_progress/],
  ['合并状态不是 CLEAN', (() => { const w = makeIntegrationWorld(); w.prs[1].gql.mergeStateStatus = 'BLOCKED'; return w })(), /merge_state: BLOCKED/],
  ['集成分支头的 CI 失败', makeIntegrationWorld({ integration: { [MIVO_INT]: { sha: MIVO_INT_SHA, runs: { [MIVO_INT_SHA]: { status: 'completed', conclusion: 'failure' } } } } }), /base_ci_not_success: integration\/x 99999999 completed\/failure/],
  ['集成分支头还没有 CI run', makeIntegrationWorld({ integration: { [MIVO_INT]: { sha: MIVO_INT_SHA, runs: {} } } }), /base_ci_not_success: integration\/x 99999999 no_run/],
]
for (const [name, world, reason] of sc3) {
  test(`SC3 集成分支单项不满足：不合并、留在队列、写明原因：${name}`, async () => {
    const env = await makeMivoEnv({ world })
    seedInt(env)
    await tick(env)
    assert.equal(directMerges(env).length, 0)
    assert.deepEqual(env.fake.writes(), [])
    assert.equal(item(env).status, 'queued')
    assert.match(item(env).reason, reason)
    assert.equal(lane(env)?.frozen, undefined)
  })
}

test('SC3 集成分支的规则集被改松（少了 review-pr (integration)）：冻结 Mivo 车道，原因写明分支，不合并', async () => {
  const world = makeIntegrationWorld()
  const checks = world.integrationRules[0].parameters.required_status_checks
  world.integrationRules[0].parameters.required_status_checks = checks.filter((c) => c.context !== 'review-pr (integration)')
  const env = await makeMivoEnv({ world })
  seedInt(env)
  const { events } = await tick(env)
  assert.equal(directMerges(env).length, 0)
  assert.match(lane(env).frozen.reason, /required_checks_weakened: 缺少 review-pr \(integration\)（integration\/x）/)
  assert.ok(events.some((e) => e.type === 'lane_frozen'))
})

test('SC3 授权后 PR 被改到 main：不合并，原因写期望的集成分支和实际分支', async () => {
  const world = makeIntegrationWorld()
  world.prs[1].rest.base = { ref: 'main' }
  const env = await makeMivoEnv({ world })
  seedInt(env)
  await tick(env)
  assert.equal(directMerges(env).length, 0)
  assert.equal(item(env).reason, 'base: 期望 integration/x，实际 main')
})

test('SC3 集成分支已不存在：不合并，留在队列写明原因，不抛错', async () => {
  const env = await makeMivoEnv({ world: makeIntegrationWorld({ integration: {} }) })
  seedInt(env)
  await tick(env)
  assert.equal(directMerges(env).length, 0)
  assert.match(item(env).reason, /base_branch_missing: integration\/x 不存在/)
})

// SC4：分支头按目标分支分开

test('SC4 集成分支 PR 落后：对着集成分支头比、不拿 main 的头；update-branch 锁 head，原因写集成分支', async () => {
  const env = await makeMivoEnv({ world: makeIntegrationWorld({ behindBy: 3 }) })
  seedInt(env)
  await tick(env)
  assert.deepEqual(compares(env), [`/repos/${MIVO}/compare/${MIVO_INT_SHA}...${MIVO_HEAD}`])
  assert.equal(directMerges(env).length, 0)
  assert.deepEqual(updateBranches(env).map((c) => c.body), [{ expected_head_sha: MIVO_HEAD }])
  assert.match(item(env).reason, /update_branch_requested \| up_to_date: 落后 integration\/x 3 个提交/)
})

test('SC4 合并时集成分支已被别人推进（第一父提交不是检查时的头）：照记 merged，冻结 Mivo 车道', async () => {
  const env = await makeMivoEnv({ world: makeIntegrationWorld({ mergeParent: 'c'.repeat(40) }) })
  seedInt(env)
  await tick(env)
  assert.equal(item(env).status, 'merged')
  assert.match(lane(env).frozen.reason, /merged_on_moved_base: #1 合并时 integration\/x 已不是检查时的 99999999（合并提交的父提交 cccccccc,dddddddd）/)
})

test('SC4 main 和集成分支的头分开记录：同一轮里集成分支 PR 对集成分支头比，main PR 对 main 头比', async () => {
  const world = makeIntegrationWorld()
  world.checks = [...world.checks, { id: 99, name: 'review-pr', status: 'completed', conclusion: 'success', app: { id: 15368 } }]
  world.prs[1].gql.mergeStateStatus = 'BEHIND' // 集成分支在本轮检查后又前进了
  const env = await makeMivoEnv({ world })
  seedInt(env, 1)
  seedMivoItem(env.store, 2)
  await tick(env)
  assert.deepEqual(lane(env).checkedBaseShas, { [MIVO_INT]: MIVO_INT_SHA })
  assert.equal(lane(env).checkedMainSha, MIVO_MAIN)
  assert.match(item(env, 1).reason, /merge_state: BEHIND（integration\/x 已越过本轮检查的 99999999），下一轮重判/)
  // 集成分支前进不停整条车道，也不让 main 的 PR 被误判：#2 照常对着 main 头比、合入
  assert.deepEqual(compares(env), [`/repos/${MIVO}/compare/${MIVO_INT_SHA}...${MIVO_HEAD}`, `/repos/${MIVO}/compare/${MIVO_MAIN}...${MIVO_HEAD}`])
  assert.deepEqual(directMerges(env).map((c) => [c.path, c.body.merge_method]), [[`/repos/${MIVO}/pulls/2/merge`, 'squash']])
  assert.equal(item(env, 2).status, 'merged')
  assert.equal(lane(env).frozen, undefined)
})

test('SC4 集成分支头 CI 没过只挡它自己的 PR：车道不暂停，同一轮 main 的 PR 照常合入', async () => {
  const world = makeIntegrationWorld({ integration: { [MIVO_INT]: { sha: MIVO_INT_SHA, runs: {} } } })
  world.checks = [...world.checks, { id: 99, name: 'review-pr', status: 'completed', conclusion: 'success', app: { id: 15368 } }]
  const env = await makeMivoEnv({ world })
  seedInt(env, 1)
  seedMivoItem(env.store, 2)
  await tick(env)
  assert.equal(lane(env).paused, undefined)
  assert.match(item(env, 1).reason, /base_ci_not_success/)
  assert.equal(item(env, 2).status, 'merged')
})
