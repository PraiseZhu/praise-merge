// SC3–SC10：一轮 tick 的行为
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTick, unfreezeLane } from '../src/tick.mjs'
import { makeEnv, makeWorld, makePr, seedItem, passingRun, HEAD, REPO } from './helpers/fake-github.mjs'

const DAY = 24 * 60 * 60 * 1000
const tick = (env, now = Date.now()) => runTick({ ...env, now })
const item = (env, id = `${REPO}#1`) => env.store.loadQueue().items.find((it) => it.id === id)
const mergeCalls = (env) => env.fake.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge'))

test('SC3 授权超过 7 天就过期，不合并；差 1 分钟照常处理', async () => {
  const now = Date.now()
  const env = await makeEnv({ shadow: false, passEvidence: true })
  seedItem(env.store, { authorizedAt: new Date(now - 7 * DAY - 60_000).toISOString() })
  await tick(env, now)
  assert.equal(item(env).status, 'expired')
  assert.equal(mergeCalls(env).length, 0)

  const env2 = await makeEnv({ shadow: false, passEvidence: true })
  seedItem(env2.store, { authorizedAt: new Date(now - 7 * DAY + 60_000).toISOString() })
  await tick(env2, now)
  assert.equal(item(env2).status, 'merged')
})

const gateCases = [
  ['Draft', { prs: { 1: makePr({ draft: true }) } }, /not_draft: draft/],
  ['base 不是默认分支', { prs: { 1: makePr({ base: { ref: 'dev' } }) } }, /base_is_default: base 期望 main，实际 dev/],
  ['有未解决讨论', { threads: { 1: [{ isResolved: false }, { isResolved: true }] } }, /threads_resolved: 未解决讨论 1 条/],
  ['必需检查失败', { checks: { [HEAD]: [{ ...passingRun('verify'), conclusion: 'failure' }] } }, /required_checks: 必需检查未通过: verify=failure/],
  ['必需检查缺失', { checks: { [HEAD]: [] } }, /verify=missing/],
  ['mergeable_state 不是 clean', { prs: { 1: makePr({ mergeable_state: 'blocked' }) } }, /mergeable_clean: mergeable_state=blocked/],
  ['作者不是 PraiseZhu', { prs: { 1: makePr({ user: { login: 'bot' } }) } }, /author: author 期望 PraiseZhu，实际 bot/],
]
for (const [name, overrides, reason] of gateCases) {
  test(`SC4 门禁单项不满足不合并：${name}`, async () => {
    const env = await makeEnv({ world: makeWorld(overrides), shadow: false, passEvidence: true })
    seedItem(env.store)
    await tick(env)
    assert.equal(mergeCalls(env).length, 0)
    assert.equal(item(env).status, 'queued')
    assert.match(item(env).reason, reason)
  })
}

test('SC4 全部满足时只调用一次 merge，sha 等于本轮读到的 head', async () => {
  const env = await makeEnv({ shadow: false, passEvidence: true })
  seedItem(env.store)
  await tick(env)
  const calls = mergeCalls(env)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body, { sha: HEAD, merge_method: 'squash' })
  assert.equal(item(env).status, 'merged')
})

test('SC4 证据门禁（占位实现）不放行时不合并', async () => {
  const env = await makeEnv({ shadow: false })
  seedItem(env.store)
  await tick(env)
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /evidence: evidence_not_implemented/)
})

test('SC5 落后 base：先 update-branch，不合并；新 head CI 未出结果不合；CI 通过才合', async () => {
  const world = makeWorld({ behind: { [HEAD]: 2 } })
  const env = await makeEnv({ world, shadow: false, passEvidence: true })
  seedItem(env.store)
  await tick(env)
  const updates = env.fake.calls.filter((c) => c.path.endsWith('/update-branch'))
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0].body, { expected_head_sha: HEAD })
  assert.equal(mergeCalls(env).length, 0)

  const NEW = 'b'.repeat(40)
  const repo = world.repos[REPO]
  repo.prs[1] = makePr({ head: { sha: NEW } })
  repo.checks[NEW] = [{ id: 2, name: 'verify', status: 'in_progress', conclusion: null }]
  await tick(env)
  assert.equal(mergeCalls(env).length, 0)
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith('/update-branch')).length, 1)

  repo.checks[NEW] = [passingRun('verify', 3)]
  await tick(env)
  assert.equal(mergeCalls(env).length, 1)
  assert.equal(mergeCalls(env)[0].body.sha, NEW)
  assert.deepEqual(item(env).seenHeads, [HEAD, NEW])
})

test('SC6 B 依赖 A：A 未合前 B 不合；A 合入后 B 才合', async () => {
  const world = makeWorld({ prs: { 1: makePr({ draft: true }), 2: makePr({ number: 2 }) } })
  const env = await makeEnv({ world, shadow: false, passEvidence: true })
  seedItem(env.store)
  seedItem(env.store, { id: `${REPO}#2`, number: 2, after: [`${REPO}#1`] })
  await tick(env)
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env, `${REPO}#2`).reason, /等依赖合入: praisezhu\/demo#1/)

  world.repos[REPO].prs[1] = makePr()
  await tick(env) // 合 A，本轮停在等 base CI
  assert.equal(item(env).status, 'merged')
  await tick(env) // base 没有 CI 且未过宽限期：仍然等
  assert.equal(mergeCalls(env).length, 1)
  await tick(env, Date.now() + 11 * 60_000) // 宽限期过后放行，合 B
  assert.equal(item(env, `${REPO}#2`).status, 'merged')
})

test('SC6 A 过期或被拒，B 变成 blocked_by_dependency 并保留原因', async () => {
  const env = await makeEnv({ shadow: false, passEvidence: true })
  seedItem(env.store, { status: 'expired' })
  seedItem(env.store, { id: `${REPO}#2`, number: 2, after: [`${REPO}#1`] })
  await tick(env)
  assert.equal(item(env, `${REPO}#2`).status, 'blocked_by_dependency')
  assert.match(item(env, `${REPO}#2`).reason, /依赖 praisezhu\/demo#1 为 expired/)
})

test('SC7 合并后 base CI 失败：车道冻结，之后不合，unfreeze 后恢复', async () => {
  const world = makeWorld({ prs: { 1: makePr(), 2: makePr({ number: 2 }) }, mergeSha: 'c'.repeat(40) })
  const env = await makeEnv({ world, shadow: false, passEvidence: true })
  seedItem(env.store)
  seedItem(env.store, { id: `${REPO}#2`, number: 2 })
  await tick(env)
  assert.equal(mergeCalls(env).length, 1)
  world.repos[REPO].checks['c'.repeat(40)] = [{ id: 9, name: 'verify', status: 'completed', conclusion: 'failure' }]
  const { events } = await tick(env)
  assert.ok(events.some((e) => e.type === 'lane_frozen'))
  assert.ok(env.store.loadLanes()[REPO].frozen)
  await tick(env)
  assert.equal(mergeCalls(env).length, 1)
  assert.equal(unfreezeLane(env.store, 'PraiseZhu/demo'), true)
  await tick(env)
  assert.equal(mergeCalls(env).length, 2)
})

test('SC8 影子模式：记录 would_merge，写请求数为 0；同一 head 只记一次', async () => {
  const env = await makeEnv({ shadow: true, passEvidence: true })
  seedItem(env.store)
  const first = await tick(env)
  assert.deepEqual(first.events.map((e) => e.type), ['would_merge'])
  assert.equal(first.events[0].head, HEAD)
  const second = await tick(env)
  assert.deepEqual(second.events, [])
  assert.deepEqual(env.fake.writes(), [])
  assert.equal(item(env).status, 'queued')
})

test('SC8 影子模式：落后时只记录 would_update_branch，不发 update-branch', async () => {
  const env = await makeEnv({ world: makeWorld({ behind: { [HEAD]: 1 } }), shadow: true, passEvidence: true })
  seedItem(env.store)
  const { events } = await tick(env)
  assert.deepEqual(events.map((e) => e.type), ['would_update_branch'])
  assert.deepEqual(env.fake.writes(), [])
})

test('SC9 有 DISABLED 文件时不发任何请求', async () => {
  const env = await makeEnv({ shadow: false, passEvidence: true })
  seedItem(env.store)
  writeFileSync(join(env.store.dir, 'DISABLED'), '')
  const result = await tick(env)
  assert.equal(result.disabled, true)
  assert.equal(env.fake.calls.length, 0)
})

test('SC10 关掉影子模式也不会合并：证据门禁是占位实现', async () => {
  const env = await makeEnv({ shadow: false })
  seedItem(env.store)
  await tick(env)
  await tick(env)
  assert.equal(mergeCalls(env).length, 0)
  assert.equal(env.fake.calls.filter((c) => c.path.endsWith('/update-branch')).length, 0)
})

test('Mivo 车道是占位实现：只记录 lane_not_implemented，不动 PR', async () => {
  const env = await makeEnv({ shadow: false, passEvidence: true })
  env.policy.repos[REPO].lane = 'mivo'
  seedItem(env.store)
  await tick(env)
  assert.equal(item(env).reason, 'lane_not_implemented')
  assert.deepEqual(env.fake.writes(), [])
})

test('merge 被 GitHub 拒绝（head 变了）时保留在队列里，并记录原因', async () => {
  const env = await makeEnv({ world: makeWorld({ mergeStatus: 409 }), shadow: false, passEvidence: true })
  seedItem(env.store)
  const { events } = await tick(env)
  assert.equal(item(env).status, 'queued')
  assert.ok(events.some((e) => e.type === 'merge_refused'))
})
