// #44：Mivo 车道另认两位同事（huangkexin-commits、shaoshenze-rgb）的 PR；合并标准不变，个人仓车道仍只认 PraiseZhu
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { enqueueRequest } from '../src/enqueue.mjs'
import { SCHEMA } from '../src/request.mjs'
import { toPolicy } from '../src/policy.mjs'
import { AUTO_INTAKE_TEXT, COLLEAGUE_INTAKE_TEXT, ORDER_INTAKE_TEXT } from '../src/auto-intake.mjs'
import { makeMivoEnv, makeMivoWorld, seedMivoItem, MIVO, MIVO_CHECKS, MIVO_HEAD } from './helpers/fake-mivo.mjs'
import { makeEnv, makeWorld, makePr, HEAD } from './helpers/fake-github.mjs'

const COLLEAGUES = ['huangkexin-commits', 'shaoshenze-rgb']
const BOT = 'praise-qa[bot]'
const ME = 'PraiseZhu'
const LABEL = 'review:merge-ready'
const ACTORS = ['praisebuild[bot]', ME]
// 现行运行配置的写法：本人要正文「合并顺序」，bot 和同事不要
const RULE = { authors: [BOT, ME, ...COLLEAGUES], label: LABEL, base: 'main', label_actors: ACTORS, order_line_authors: [ME] }
const MIVO_ENTRY = { lane: 'mivo', required_checks: MIVO_CHECKS, checks_integration_id: 15368 }
const tick = (env) => runTick({ ...env, now: Date.now() })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))
const request = (repo, number, head = MIVO_HEAD) => ({ schema: SCHEMA, session_id: 's1', authorized_at: new Date().toISOString(), authorization_text: '合并', prs: [{ repo, number, head_sha_at_auth: head }] })

// 作者各不相同、其余都满足接单条件的 Mivo PR（正文没有「合并顺序」）
function worldWithAuthors(logins, overrides = {}) {
  const world = makeMivoWorld({ mergeQueue: null, ...overrides })
  world.prs = {}
  logins.forEach((login, i) => {
    const n = i + 1
    const rest = { number: n, state: 'open', merged: false, draft: false, user: { login }, base: { ref: 'main' }, head: { sha: MIVO_HEAD }, labels: [{ name: LABEL }], body: '修了个 bug' }
    world.prs[n] = { rest, gql: { id: `PR_${n}`, mergeStateStatus: 'CLEAN', mergeQueueEntry: null } }
  })
  return world
}

for (const login of COLLEAGUES) {
  test(`#44 SC1 Mivo 车道：${login} 的 PR 说「合并」能入队，门禁全过就合`, async () => {
    const env = await makeMivoEnv({ world: worldWithAuthors([login]) })
    const result = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request: request(MIVO, 1) })
    assert.deepEqual([result.accepted, result.rejected], [[`${MIVO}#1`], []])
    await tick(env)
    assert.equal(item(env).status, 'merged')
    assert.equal(directMerges(env).length, 1)
  })

  test(`#44 SC2 个人仓车道仍只认 PraiseZhu：${login} 的 PR 入队被拒`, async () => {
    const env = await makeEnv({ world: makeWorld({ prs: { 1: makePr({ user: { login } }) } }) })
    const result = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request: request('PraiseZhu/demo', 1, HEAD) })
    assert.deepEqual(result.accepted, [])
    assert.equal(result.rejected[0].reason, `author 期望 PraiseZhu，实际 ${login}`)
  })
}

test('#44 SC1 Mivo 车道：名单外的作者照旧拒收和不合，原因带完整名单和实际作者', async () => {
  const env = await makeMivoEnv({ world: worldWithAuthors(['huangkexin']) })
  const result = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request: request(MIVO, 1) })
  assert.equal(result.rejected[0].reason, 'author 期望 PraiseZhu 或 praise-qa[bot] 或 huangkexin-commits 或 shaoshenze-rgb，实际 huangkexin')
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(directMerges(env).length, 0)
  assert.match(item(env).reason, /author: 期望 PraiseZhu 或 praise-qa\[bot\] 或 huangkexin-commits 或 shaoshenze-rgb，实际 huangkexin/)
})

test('#44 SC3 自动接单：同事 PR 不要求正文「合并顺序」，授权说明写同事；本人 PR 没写顺序照旧不接', async () => {
  // main 没有 CI run：车道暂停，只看接单
  const env = await makeMivoEnv({ world: worldWithAuthors([...COLLEAGUES, ME, BOT], { mainRuns: {} }), autoIntake: RULE })
  const { events } = await tick(env)
  const texts = Object.fromEntries(env.store.loadQueue().items.map((it) => [it.number, it.authorizationText]))
  assert.deepEqual(texts, { 1: COLLEAGUE_INTAKE_TEXT, 2: COLLEAGUE_INTAKE_TEXT, 4: AUTO_INTAKE_TEXT })
  assert.ok(events.some((e) => e.type === 'merge_order_invalid' && e.pr === 3), '本人 PR 没写合并顺序照旧报 merge_order_invalid')
  assert.notEqual(COLLEAGUE_INTAKE_TEXT, ORDER_INTAKE_TEXT)
  assert.deepEqual(env.fake.writes(), [])
})

test('#44 SC3 auto_intake.authors 能填两位同事；名单外的作者加载报错，带条目名和完整名单', () => {
  const policy = toPolicy({ repos: { [MIVO]: { ...MIVO_ENTRY, auto_intake: RULE } } })
  assert.deepEqual(policy.repos[MIVO].autoIntake.authors, [BOT, ME, ...COLLEAGUES])
  assert.throws(
    () => toPolicy({ repos: { [MIVO]: { ...MIVO_ENTRY, auto_intake: { ...RULE, authors: [...COLLEAGUES, 'shaoshenze'] } } } }),
    /xindong\/mivo-canvas-plugin\.auto_intake\.authors 只能是 PraiseZhu 或 praise-qa\[bot\] 或 huangkexin-commits 或 shaoshenze-rgb，实际 shaoshenze$/,
  )
})
