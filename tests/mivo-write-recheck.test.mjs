// #20 审查修复：读 PR 快照之后、发写请求之前 PR 被改了目标分支或 head，就不写
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, seedMivoItem, MIVO, MIVO_INT } from './helpers/fake-mivo.mjs'

const tick = (env) => runTick({ ...env, now: Date.now() })
const item = (env) => env.store.loadQueue().items.find((it) => it.number === 1)
const writes = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/(merge|update-branch)$/.test(c.path))

const intWorld = (overrides = {}) => makeIntegrationWorld(overrides)
const mainWorld = (overrides = {}) => makeMivoWorld({ mergeQueue: null, ...overrides })
// 追分支的路径：GitHub 要求先同步（BEHIND）且确实落后；CLEAN 时直接合，不追（#26）
const behindWorld = (world) => {
  world.prs[1].gql.mergeStateStatus = 'BEHIND'
  return world
}

const cases = [
  ['合并前 integration/x → main', intWorld(), MIVO_INT, { base: { ref: 'main' } }, /pr_changed_before_write: base 期望 integration\/x，实际 main/],
  ['合并前 integration/x → integration/y（同一规则集，审查检查仍有效）', intWorld(), MIVO_INT, { base: { ref: 'integration/y' } }, /pr_changed_before_write: base 期望 integration\/x，实际 integration\/y/],
  ['合并前 main → integration/x', mainWorld(), undefined, { base: { ref: MIVO_INT } }, /pr_changed_before_write: base 期望 main，实际 integration\/x/],
  ['合并前换了 head', intWorld(), MIVO_INT, { head: { sha: 'e'.repeat(40) } }, /pr_changed_before_write: head 期望 dddddddd，实际 eeeeeeee/],
  ['合并前被关掉', mainWorld(), undefined, { state: 'closed' }, /pr_changed_before_write: state 期望 open，实际 closed/],
  ['追分支前 integration/x → main', behindWorld(intWorld({ behindBy: 3 })), MIVO_INT, { base: { ref: 'main' } }, /pr_changed_before_write: base 期望 integration\/x，实际 main/],
  ['追分支前 main → integration/x', behindWorld(mainWorld({ behindBy: 3 })), undefined, { base: { ref: MIVO_INT } }, /pr_changed_before_write: base 期望 main，实际 integration\/x/],
]
for (const [name, world, base, change, reason] of cases) {
  test(`写前复核：${name} → 不发 merge / update-branch，留在队列写明期望值和实际值`, async () => {
    world.prs[1].restOnReread = change
    const env = await makeMivoEnv({ world })
    seedMivoItem(env.store, 1, base ? { base } : {})
    await tick(env)
    assert.deepEqual(writes(env), [])
    assert.equal(item(env).status, 'queued')
    assert.match(item(env).reason, reason)
    assert.equal(env.store.loadLanes()[MIVO]?.frozen, undefined)
  })
}

test('写前复核：影子模式同样先复核，PR 被改到别的分支时不记 would_merge', async () => {
  const world = intWorld()
  world.prs[1].restOnReread = { base: { ref: 'main' } }
  const env = await makeMivoEnv({ world, shadow: true })
  seedMivoItem(env.store, 1, { base: MIVO_INT })
  const { events } = await tick(env)
  assert.deepEqual(events.filter((e) => e.type.startsWith('would_')), [])
  assert.match(item(env).reason, /pr_changed_before_write/)
})

test('写前复核：PR 没变时照常合并，写前多读一次 PR', async () => {
  const env = await makeMivoEnv({ world: intWorld() })
  seedMivoItem(env.store, 1, { base: MIVO_INT })
  await tick(env)
  assert.equal(writes(env).length, 1)
  assert.equal(env.fake.calls.filter((c) => c.method === 'GET' && c.path === `/repos/${MIVO}/pulls/1`).length, 2)
})

for (const [name, world, base] of [
  ['追分支前（update-branch 不会拒绝 Draft）', behindWorld(intWorld({ behindBy: 3 })), MIVO_INT],
  ['合并前', mainWorld(), undefined],
]) {
  test(`写前复核：${name}作者把 PR 转成 Draft → 不发写请求，留在队列`, async () => {
    world.prs[1].restOnReread = { draft: true }
    const env = await makeMivoEnv({ world })
    seedMivoItem(env.store, 1, base ? { base } : {})
    await tick(env)
    assert.deepEqual(writes(env), [])
    assert.equal(item(env).status, 'queued')
    assert.match(item(env).reason, /pr_changed_before_write: draft 期望 false，实际 true/)
  })
}
