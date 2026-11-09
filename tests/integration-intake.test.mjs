// #42：自动接单也接合进集成分支（integration/*）的本人 PR 和 bot PR
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { toPolicy } from '../src/policy.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, MIVO, MIVO_CHECKS, MIVO_HEAD, MIVO_INT } from './helpers/fake-mivo.mjs'

const BOT = 'praise-qa[bot]'
const ME = 'PraiseZhu'
const LABEL = 'review:merge-ready'
const ACTORS = ['praisebuild[bot]', ME]
const RULE = { authors: [BOT, ME], label: LABEL, base: ['main', 'integration/*'], label_actors: ACTORS, order_line_authors: [ME] }
const MIVO_ENTRY = { lane: 'mivo', required_checks: MIVO_CHECKS, checks_integration_id: 15368 }
const tick = (env) => runTick({ ...env, now: Date.now() })
const items = (env) => env.store.loadQueue().items
const listCalls = (env) => env.fake.calls.filter((c) => c.method === 'GET' && c.path === `/repos/${MIVO}/pulls`)
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))

// 符合接单条件的 PR（默认 bot、合进 main、带标签）
const pr = (number, patch = {}) => ({
  number, state: 'open', merged: false, draft: false, user: { login: BOT }, base: { ref: 'main' }, head: { sha: MIVO_HEAD }, labels: [{ name: LABEL }], body: '', ...patch,
})
// main 还没有 CI run：车道暂停，条目只接单不处理，用来单看接单
function intakeWorld(prs) {
  const world = makeMivoWorld({ mergeQueue: null, mainRuns: {} })
  world.prs = {}
  for (const [n, patch] of Object.entries(prs)) world.prs[n] = { rest: pr(Number(n), patch), gql: { id: `PR_${n}`, mergeStateStatus: 'CLEAN', mergeQueueEntry: null } }
  return world
}

test('#42 SC1 base 写 main 和 integration/*：合进 main 和集成分支的都接单，条目记 PR 实际的目标分支；其他分支不接', async () => {
  const env = await makeMivoEnv({ world: intakeWorld({
    1: {},
    2: { base: { ref: MIVO_INT } },
    3: { user: { login: ME }, base: { ref: 'integration/cindy-media-phase2' }, body: '合并顺序：无' },
    4: { base: { ref: 'release/x' } },
    5: { base: { ref: 'integration/a/b' } },
  }), autoIntake: RULE })
  const { events } = await tick(env)
  assert.deepEqual(items(env).map((it) => [it.number, it.base]), [[1, 'main'], [2, MIVO_INT], [3, 'integration/cindy-media-phase2']])
  assert.deepEqual(events.filter((e) => e.type === 'auto_intake').map((e) => e.pr), [1, 2, 3])
  // 有多个分支时列表请求不按 base 过滤，仍只发一次
  assert.equal(listCalls(env).length, 1)
  assert.equal(listCalls(env)[0].query.base, undefined)
  assert.deepEqual(env.fake.writes(), [])
})

test('#42 SC2 base 只写 main（旧写法）：行为不变，列表按 base=main 过滤，集成分支的 PR 不接', async () => {
  const env = await makeMivoEnv({ world: intakeWorld({ 1: {}, 2: { base: { ref: MIVO_INT } } }), autoIntake: { ...RULE, base: 'main' } })
  await tick(env)
  assert.deepEqual(items(env).map((it) => it.number), [1])
  assert.equal(listCalls(env)[0].query.base, 'main')
})

test('#42 SC3 base 可写一个分支或数组，解析成 bases', () => {
  const parse = (base) => toPolicy({ repos: { [MIVO]: { ...MIVO_ENTRY, auto_intake: { ...RULE, base } } } }).repos[MIVO].autoIntake.bases
  assert.deepEqual(parse('main'), ['main'])
  assert.deepEqual(parse(['main', 'integration/*']), ['main', 'integration/*'])
  assert.deepEqual(parse(['integration/cindy-media-phase2']), ['integration/cindy-media-phase2'])
})

for (const [name, base, actual] of [
  ['release/*', 'release/*', 'release/*'],
  ['数组里有再深一层的集成分支', ['main', 'integration/a/b'], 'integration/a/b'],
  ['写成 integration/**', ['integration/**'], 'integration/**'],
  ['空数组', [], '[]'],
]) {
  test(`#42 SC3 加载配置时报错：auto_intake.base ${name}`, () => {
    assert.throws(
      () => toPolicy({ repos: { [MIVO]: { ...MIVO_ENTRY, auto_intake: { ...RULE, base } } } }),
      (err) => err.message === `${MIVO}.auto_intake.base 应为 main 或 integration/*，实际 ${actual}`,
    )
  })
}

test('#42 SC4 自动接单的 bot PR 合进集成分支：走集成分支门禁，用 merge 合并、锁定 head', async () => {
  const world = makeIntegrationWorld()
  world.prs[1].rest.user = { login: BOT }
  world.prs[1].rest.labels = [{ name: LABEL }]
  const env = await makeMivoEnv({ world, autoIntake: RULE })
  const { events } = await tick(env)
  assert.equal(items(env)[0].base, MIVO_INT)
  assert.equal(items(env)[0].sessionId, 'auto-intake')
  assert.equal(items(env)[0].status, 'merged')
  assert.deepEqual(directMerges(env).map((c) => c.body), [{ sha: MIVO_HEAD, merge_method: 'merge' }])
  // 规则按集成分支读，不是 main
  assert.ok(env.fake.calls.some((c) => c.path === `/repos/${MIVO}/rules/branches/integration%2Fx`))
  assert.ok(events.some((e) => e.type === 'auto_intake') && events.some((e) => e.type === 'merged'))
})

test('#42 SC4 自动接单的本人 PR 合进集成分支：照旧按正文「合并顺序」等依赖，依赖没合入不合', async () => {
  const world = makeIntegrationWorld()
  world.prs[1].rest.user = { login: ME }
  world.prs[1].rest.labels = [{ name: LABEL }]
  world.prs[1].rest.body = '合并顺序：等 #9 合入后'
  world.prs[9] = { rest: pr(9, { user: { login: 'someone' }, labels: [] }), gql: { id: 'PR_9', mergeStateStatus: 'CLEAN', mergeQueueEntry: null } }
  const env = await makeMivoEnv({ world, autoIntake: RULE })
  await tick(env)
  assert.equal(items(env)[0].base, MIVO_INT)
  assert.equal(items(env)[0].status, 'queued')
  assert.match(items(env)[0].reason, /等依赖合入/)
  assert.equal(directMerges(env).length, 0)
})
