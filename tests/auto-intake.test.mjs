// #30：伙伴只合 Mivo；praise-qa[bot] 的 Mivo PR 自动接单
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { enqueueRequest } from '../src/enqueue.mjs'
import { SCHEMA } from '../src/request.mjs'
import { toPolicy } from '../src/policy.mjs'
import { toEventLines } from '../src/events.mjs'
import { AUTO_INTAKE_SESSION, AUTO_INTAKE_TEXT } from '../src/auto-intake.mjs'
import { makeMivoEnv, makeMivoWorld, seedMivoItem, MIVO, MIVO_CHECKS, MIVO_HEAD } from './helpers/fake-mivo.mjs'
import { makeEnv, makeWorld, makePr, seedItem, HEAD, REPO } from './helpers/fake-github.mjs'

const BOT = 'praise-qa[bot]'
const LABEL = 'review:merge-ready'
const RULE = { authors: [BOT], label: LABEL, base: 'main' }
const NEW_HEAD = 'e'.repeat(40)
const tick = (env, now = Date.now()) => runTick({ ...env, now })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))
const listCalls = (env) => env.fake.calls.filter((c) => c.method === 'GET' && c.path === `/repos/${MIVO}/pulls`)
const request = (repo, number, head = MIVO_HEAD) => ({ schema: SCHEMA, session_id: 's1', authorized_at: new Date().toISOString(), authorization_text: '合并', prs: [{ repo, number, head_sha_at_auth: head }] })

// 符合自动接单条件的 bot PR（open、非 Draft、作者 praise-qa[bot]、base main、带标签）
const botRest = (number, patch = {}) => ({
  number, state: 'open', merged: false, draft: false, user: { login: BOT }, base: { ref: 'main' }, head: { sha: MIVO_HEAD }, labels: [{ name: LABEL }], ...patch,
})
function botWorld({ prs = { 1: {} }, ...overrides } = {}) {
  const world = makeMivoWorld({ mergeQueue: null, ...overrides })
  world.prs = {}
  for (const [n, patch] of Object.entries(prs)) world.prs[n] = { rest: botRest(Number(n), patch), gql: { id: `PR_${n}`, mergeStateStatus: 'CLEAN', mergeQueueEntry: null } }
  return world
}
// main 还没有 CI run：车道暂停，条目只接单不处理，用来单看接单
const paused = (opts) => botWorld({ ...opts, mainRuns: {} })

// SC1 ---------------------------------------------------------------------------------------------
test('#30 SC1 接单：Mivo 收 praise-qa[bot] 的 PR；别的 bot 拒收，原因带期望值和实际值', async () => {
  const world = botWorld({ prs: { 1: {}, 2: { user: { login: 'dependabot[bot]' } } } })
  const env = await makeMivoEnv({ world })
  const ok = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request: request(MIVO, 1) })
  assert.deepEqual([ok.accepted, ok.rejected], [[`${MIVO}#1`], []])
  const bad = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request: request(MIVO, 2) })
  assert.deepEqual(bad.accepted, [])
  assert.equal(bad.rejected[0].reason, 'author 期望 PraiseZhu 或 praise-qa[bot]，实际 dependabot[bot]')
})

test('#30 SC1 接单：个人仓车道仍只认 PraiseZhu，praise-qa[bot] 的 PR 拒收', async () => {
  const env = await makeEnv({ world: makeWorld({ prs: { 1: makePr({ user: { login: BOT } }) } }) })
  const result = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request: request('PraiseZhu/demo', 1, HEAD) })
  assert.deepEqual(result.accepted, [])
  assert.equal(result.rejected[0].reason, `author 期望 PraiseZhu，实际 ${BOT}`)
})

test('#30 SC1 门禁：Mivo 车道合 praise-qa[bot] 的 PR；作者是别人时不合，原因带期望值和实际值', async () => {
  const env = await makeMivoEnv({ world: botWorld() })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(item(env).status, 'merged')

  const other = await makeMivoEnv({ world: botWorld({ prs: { 1: { user: { login: 'someone[bot]' } } } }) })
  seedMivoItem(other.store)
  await tick(other)
  assert.equal(directMerges(other).length, 0)
  assert.match(item(other).reason, /author: 期望 PraiseZhu 或 praise-qa\[bot\]，实际 someone\[bot\]/)
})

test('#30 SC1 门禁：个人仓车道作者是 praise-qa[bot] 时不合', async () => {
  const env = await makeEnv({ world: makeWorld({ prs: { 1: makePr({ user: { login: BOT } }) } }), shadow: false, passEvidence: true })
  seedItem(env.store)
  await tick(env)
  assert.equal(env.fake.calls.filter((c) => c.method === 'PUT').length, 0)
  assert.match(env.store.loadQueue().items[0].reason, /author: author 期望 PraiseZhu，实际 praise-qa\[bot\]/)
})

// SC2 ---------------------------------------------------------------------------------------------
const MIVO_ENTRY = { lane: 'mivo', required_checks: MIVO_CHECKS, checks_integration_id: 15368 }

test('#30 SC2 mivo 条目上的 auto_intake 能解析', () => {
  const policy = toPolicy({ repos: { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: RULE } } })
  assert.deepEqual(policy.repos[MIVO].autoIntake, RULE)
  assert.equal(toPolicy({ repos: { 'xindong/mivo-canvas-plugin': MIVO_ENTRY } }).repos[MIVO].autoIntake, null)
})

for (const [name, repos, message] of [
  ['写在个人仓条目上', { 'PraiseZhu/demo': { lane: 'personal', required_checks: ['verify'], auto_intake: RULE } }, /PraiseZhu\/demo\.auto_intake 只能写在 lane 为 mivo 的条目上，实际 lane personal/],
  ['写在通配条目上', { 'PraiseZhu/*': { lane: 'personal', required_checks: 'all', auto_intake: RULE } }, /PraiseZhu\/\*\.auto_intake 只能写在 lane 为 mivo 的条目上，实际 lane personal/],
  ['authors 里有名单外的作者', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, authors: ['dependabot[bot]'] } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.authors 只能是 PraiseZhu 或 praise-qa\[bot\]，实际 dependabot\[bot\]/],
  ['authors 为空', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, authors: [] } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.authors 至少一项/],
  ['缺 label', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, label: '' } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.label 缺失/],
  ['base 不是 Mivo 接受的分支', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, base: 'release/x' } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.base 应为 main 或 integration\/\*，实际 release\/x/],
]) {
  test(`#30 SC2 加载配置时报错：auto_intake ${name}`, () => {
    assert.throws(() => toPolicy({ repos }), message)
  })
}

// SC3 ---------------------------------------------------------------------------------------------
test('#30 SC3 一轮里只接符合全部条件的 PR，不符合任一条的不接；只发一次列表请求，只读', async () => {
  const world = paused({ prs: {
    1: {},
    2: { draft: true },
    3: { user: { login: 'PraiseZhu' } },
    4: { user: { login: 'dependabot[bot]' } },
    5: { base: { ref: 'integration/x' } },
    6: { labels: [{ name: 'touches:redline' }] },
    7: { state: 'closed' },
  } })
  const env = await makeMivoEnv({ world, autoIntake: RULE })
  const { events } = await tick(env)
  const items = env.store.loadQueue().items
  assert.deepEqual(items.map((it) => it.number), [1])
  assert.deepEqual(
    [items[0].sessionId, items[0].authorizationText, items[0].autoIntakeLabel, items[0].base, items[0].headShaAtAuth, items[0].status],
    [AUTO_INTAKE_SESSION, AUTO_INTAKE_TEXT, LABEL, 'main', MIVO_HEAD, 'queued'],
  )
  assert.deepEqual(events.filter((e) => e.type === 'auto_intake'), [{ type: 'auto_intake', repo: MIVO, pr: 1, head: MIVO_HEAD }])
  assert.equal(listCalls(env).length, 1)
  assert.deepEqual(env.fake.writes(), [])
  // 接单事件叫醒伙伴
  assert.ok(toEventLines(events).some((line) => JSON.parse(line).type === 'auto_intake'))
})

test('#30 SC3 列表请求带 state=open、base=auto_intake.base；policy 没有 auto_intake 时不发列表请求', async () => {
  const env = await makeMivoEnv({ world: paused(), autoIntake: RULE })
  await tick(env)
  const { query } = listCalls(env)[0]
  assert.deepEqual([query.state, query.base, query.per_page], ['open', 'main', '100'])

  const none = await makeMivoEnv({ world: paused() })
  await tick(none)
  assert.equal(listCalls(none).length, 0)
  assert.deepEqual(none.store.loadQueue().items, [])
})

test('#30 SC3 已有未完成条目时不重复接单：连跑两轮只接一次；用户说「合并」接的条目不被改成自动接单', async () => {
  const env = await makeMivoEnv({ world: paused(), autoIntake: RULE })
  const first = await tick(env)
  const second = await tick(env)
  assert.equal(first.events.filter((e) => e.type === 'auto_intake').length, 1)
  assert.equal(second.events.filter((e) => e.type === 'auto_intake').length, 0)
  assert.equal(env.store.loadQueue().items.length, 1)

  const manual = await makeMivoEnv({ world: paused(), autoIntake: RULE })
  seedMivoItem(manual.store, 1, { status: 'queued', sessionId: 's1' })
  await tick(manual)
  assert.equal(item(manual).sessionId, 's1')
  assert.equal(item(manual).autoIntakeLabel, undefined)
})

for (const [status, head, intake] of [
  ['queued', NEW_HEAD, false],
  ['merged', NEW_HEAD, false],
  ['closed', NEW_HEAD, false],
  ['expired', MIVO_HEAD, true],
  ['dequeued', MIVO_HEAD, false],
  ['dequeued', NEW_HEAD, true],
  ['rejected', MIVO_HEAD, false],
  ['rejected', NEW_HEAD, true],
  ['blocked_by_dependency', MIVO_HEAD, false],
  ['blocked_by_dependency', NEW_HEAD, true],
]) {
  const headNote = head === MIVO_HEAD ? 'head 没变' : 'head 变了'
  test(`#30 SC3 已有 ${status} 条目、${headNote}：${intake ? '重新接单' : '不接'}`, async () => {
    const env = await makeMivoEnv({ world: paused({ prs: { 1: { head: { sha: head } } } }), autoIntake: RULE })
    seedMivoItem(env.store, 1, { status, reason: status, sessionId: 's1', seenHeads: [MIVO_HEAD] })
    const { events } = await tick(env)
    const intakes = events.filter((e) => e.type === 'auto_intake')
    assert.equal(intakes.length, intake ? 1 : 0)
    assert.equal(env.store.loadQueue().items.length, 1)
    if (intake) {
      assert.deepEqual([item(env).status, item(env).sessionId, item(env).headShaAtAuth], ['queued', AUTO_INTAKE_SESSION, head])
      assert.equal(intakes[0].reason, `重新接单（上次 ${status}）`)
      assert.deepEqual(item(env).seenHeads, [...new Set([MIVO_HEAD, head])])
    } else {
      assert.deepEqual([item(env).status, item(env).sessionId], [status, 's1'])
    }
  })
}

test('#30 SC3 Mivo 车道冻结时不列 PR、不接单', async () => {
  const env = await makeMivoEnv({ world: paused(), autoIntake: RULE })
  env.store.saveLanes({ [MIVO]: { frozen: { reason: 'merged_on_moved_main: 测试', at: new Date().toISOString() } } })
  await tick(env)
  assert.deepEqual(env.fake.calls, [])
  assert.deepEqual(env.store.loadQueue().items, [])
})

// SC4 ---------------------------------------------------------------------------------------------
test('#30 SC4 标签在、门禁全过：同一轮接单并直接合并，sha 锁定当前 head', async () => {
  const env = await makeMivoEnv({ world: botWorld(), autoIntake: RULE })
  const { events } = await tick(env)
  assert.deepEqual(directMerges(env).map((c) => c.body), [{ sha: MIVO_HEAD, merge_method: 'squash' }])
  assert.equal(item(env).status, 'merged')
  const at = (type) => events.findIndex((e) => e.type === type)
  assert.ok(at('auto_intake') >= 0 && at('auto_intake') < at('merged'), '先接单再合并')
})

test('#30 SC4 自动接单的条目标签被摘掉：不合，留在队列，原因 auto_intake_label_missing；标签挂回后合并', async () => {
  const env = await makeMivoEnv({ world: botWorld(), autoIntake: RULE })
  seedMivoItem(env.store, 1, { sessionId: AUTO_INTAKE_SESSION, autoIntakeLabel: LABEL })
  env.world.prs[1].rest.labels = []
  await tick(env)
  assert.equal(directMerges(env).length, 0)
  assert.equal(item(env).status, 'queued')
  // 门禁这一层就拦下，不等到写前复核
  assert.match(item(env).reason, /^auto_intake_label_missing: 期望标签 review:merge-ready，PR 上没有$/)

  env.world.prs[1].rest.labels = [{ name: LABEL }]
  await tick(env)
  assert.deepEqual(directMerges(env).map((c) => c.body), [{ sha: MIVO_HEAD, merge_method: 'squash' }])
})

test('#30 SC4 门禁检查后、写合并请求前标签被摘掉：不写，原因带 auto_intake_label_missing', async () => {
  const world = botWorld()
  world.prs[1].restOnReread = { labels: [] }
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store, 1, { sessionId: AUTO_INTAKE_SESSION, autoIntakeLabel: LABEL })
  await tick(env)
  assert.deepEqual(env.fake.writes(), [])
  assert.match(item(env).reason, /pr_changed_before_write: auto_intake_label_missing/)
})

test('#30 SC4 用户说「合并」接的条目不要求标签', async () => {
  const env = await makeMivoEnv({ world: botWorld({ prs: { 1: { labels: [] } } }) })
  seedMivoItem(env.store)
  await tick(env)
  assert.equal(item(env).status, 'merged')
})

test('#30 SC4 自动接单的条目原有门禁照旧：有未解决讨论就不合', async () => {
  const env = await makeMivoEnv({ world: botWorld({ threads: [{ isResolved: false }] }), autoIntake: RULE })
  await tick(env)
  assert.equal(item(env).sessionId, AUTO_INTAKE_SESSION)
  assert.equal(directMerges(env).length, 0)
  assert.match(item(env).reason, /threads_resolved: 未解决讨论 1 条/)
})

// SC5 ---------------------------------------------------------------------------------------------
for (const [name, world, type] of [
  ['门禁全过', botWorld(), 'would_merge'],
  ['GitHub 要求先同步', (() => { const w = botWorld({ behindBy: 2 }); w.prs[1].gql.mergeStateStatus = 'BEHIND'; return w })(), 'would_update_branch'],
]) {
  test(`#30 SC5 影子模式${name}：照常接单，事件只有 would_*（${type}），不发写请求，也不叫醒伙伴`, async () => {
    const env = await makeMivoEnv({ world, shadow: true, autoIntake: RULE })
    const { events } = await tick(env)
    assert.deepEqual([item(env).sessionId, item(env).status], [AUTO_INTAKE_SESSION, 'queued'])
    assert.deepEqual(events.map((e) => e.type), ['would_auto_intake', type])
    assert.deepEqual(env.fake.writes(), [])
    assert.deepEqual(toEventLines(events), [])
  })
}
