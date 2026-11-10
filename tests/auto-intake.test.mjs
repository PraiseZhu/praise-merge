// #30：伙伴只合 Mivo；praise-qa[bot] 的 Mivo PR 自动接单
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { enqueueRequest } from '../src/enqueue.mjs'
import { SCHEMA } from '../src/request.mjs'
import { toPolicy } from '../src/policy.mjs'
import { toEventLines } from '../src/events.mjs'
import { AUTO_INTAKE_SESSION, AUTO_INTAKE_TEXT } from '../src/auto-intake.mjs'
import { makeMivoEnv, makeMivoWorld, seedMivoItem, labeledEvent, MIVO, MIVO_CHECKS, MIVO_HEAD } from './helpers/fake-mivo.mjs'
import { makeEnv, makeWorld, makePr, seedItem, HEAD, REPO } from './helpers/fake-github.mjs'

const BOT = 'praise-qa[bot]'
const LABEL = 'review:merge-ready'
const ACTORS = ['praisebuild[bot]', 'PraiseZhu']
const RULE = { authors: [BOT], label: LABEL, base: 'main', label_actors: ACTORS }
const PARSED_RULE = { authors: [BOT], label: LABEL, bases: ['main'], labelActors: ACTORS, orderLineAuthors: [] }
// 自动接单的条目在队列里的样子（接单时记下标签和标签操作者名单）
const AUTO_ITEM = { sessionId: 'auto-intake', autoIntakeLabel: LABEL, autoIntakeLabelActors: ACTORS }
const NEW_HEAD = 'e'.repeat(40)
const tick = (env, now = Date.now()) => runTick({ ...env, now })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))
const listCalls = (env) => env.fake.calls.filter((c) => c.method === 'GET' && c.path === `/repos/${MIVO}/pulls`)
const eventCalls = (env) => env.fake.calls.filter((c) => c.method === 'GET' && /\/issues\/\d+\/events$/.test(c.path))
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
  assert.equal(bad.rejected[0].reason, 'author 期望 PraiseZhu 或 praise-qa[bot] 或 huangkexin-commits 或 shaoshenze-rgb，实际 dependabot[bot]')
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
  assert.match(item(other).reason, /author: 期望 PraiseZhu 或 praise-qa\[bot\] 或 huangkexin-commits 或 shaoshenze-rgb，实际 someone\[bot\]/)
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
  assert.deepEqual(policy.repos[MIVO].autoIntake, PARSED_RULE)
  assert.equal(toPolicy({ repos: { 'xindong/mivo-canvas-plugin': MIVO_ENTRY } }).repos[MIVO].autoIntake, null)
})

for (const [name, repos, message] of [
  ['写在个人仓条目上', { 'PraiseZhu/demo': { lane: 'personal', required_checks: ['verify'], auto_intake: RULE } }, /PraiseZhu\/demo\.auto_intake 只能写在 lane 为 mivo 的条目上，实际 lane personal/],
  ['写在通配条目上', { 'PraiseZhu/*': { lane: 'personal', required_checks: 'all', auto_intake: RULE } }, /PraiseZhu\/\*\.auto_intake 只能写在 lane 为 mivo 的条目上，实际 lane personal/],
  ['authors 里有名单外的作者', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, authors: ['dependabot[bot]'] } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.authors 只能是 PraiseZhu 或 praise-qa\[bot\] 或 huangkexin-commits 或 shaoshenze-rgb，实际 dependabot\[bot\]/],
  ['authors 为空', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, authors: [] } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.authors 至少一项/],
  ['缺 label', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, label: '' } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.label 缺失/],
  ['base 不是 Mivo 接受的分支', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, base: 'release/x' } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.base 应为 main 或 integration\/\*，实际 release\/x/],
  ['缺 label_actors', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, label_actors: undefined } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.label_actors 至少一项/],
  ['label_actors 为空', { 'xindong/mivo-canvas-plugin': { ...MIVO_ENTRY, auto_intake: { ...RULE, label_actors: [] } } }, /xindong\/mivo-canvas-plugin\.auto_intake\.label_actors 至少一项/],
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
  assert.deepEqual(items[0].autoIntakeLabelActors, ACTORS)
  assert.deepEqual(events.filter((e) => e.type === 'auto_intake'), [{ type: 'auto_intake', repo: MIVO, pr: 1, head: MIVO_HEAD }])
  assert.equal(listCalls(env).length, 1)
  // 只为通过其余接单条件的 #1 读 events
  assert.deepEqual(eventCalls(env).map((c) => c.path), [`/repos/${MIVO}/issues/1/events`])
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
  seedMivoItem(env.store, 1, AUTO_ITEM)
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
  seedMivoItem(env.store, 1, AUTO_ITEM)
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

// SC8 ---------------------------------------------------------------------------------------------
const wakeTypes = (events) => toEventLines(events).map((line) => JSON.parse(line).type)
const byActor = (...logins) => logins.map((login, i) => labeledEvent(LABEL, login, 2000 + i))

for (const [name, events, intake, reason] of [
  ['最近一次由审查机 praisebuild[bot] 挂上', byActor('praisebuild[bot]'), true, null],
  ['最近一次由 PraiseZhu 挂上（审查机写入关闭时）', byActor('PraiseZhu'), true, null],
  ['由只有 Triage 权限的人挂上', byActor('someone'), false, /auto_intake_label_actor: 标签 review:merge-ready 最近一次由 someone 挂上，期望 praisebuild\[bot\] 或 PraiseZhu/],
  ['审查机挂过、摘掉后被别人补挂（看最近一次）', [labeledEvent(LABEL, 'praisebuild[bot]', 2000), labeledEvent(LABEL, 'praisebuild[bot]', 2001, 'unlabeled'), labeledEvent(LABEL, 'someone', 2002)], false, /最近一次由 someone 挂上/],
  ['别人挂过、摘掉后审查机重新挂上', [labeledEvent(LABEL, 'someone', 2000), labeledEvent(LABEL, 'someone', 2001, 'unlabeled'), labeledEvent(LABEL, 'praisebuild[bot]', 2002)], true, null],
  ['只有别的标签的 labeled 事件', [labeledEvent('touches:redline', 'praisebuild[bot]', 2000)], false, /auto_intake_label_actor: 没找到标签 review:merge-ready 的 labeled 事件/],
]) {
  test(`#30 SC8 接单核对标签操作者：${name} → ${intake ? '接单' : '不接'}`, async () => {
    const env = await makeMivoEnv({ world: paused({ prs: { 1: {} } }), autoIntake: RULE })
    env.world.prs[1].events = events
    const { events: out } = await tick(env)
    assert.equal(env.store.loadQueue().items.length, intake ? 1 : 0)
    if (intake) return
    const skipped = out.find((e) => e.type === 'auto_intake_skipped')
    assert.match(skipped.reason, reason)
    assert.deepEqual(wakeTypes(out).filter((t) => t.startsWith('auto_intake')), [], '操作者不对只记日志，不叫醒')
  })
}

test('#30 SC8 events 分页没读完前不下结论：第 2 页里别人最近一次补挂，不接', async () => {
  const filler = Array.from({ length: 120 }, (_, i) => labeledEvent(`noise-${i}`, 'praisebuild[bot]', 100 + i))
  const env = await makeMivoEnv({ world: paused(), autoIntake: RULE })
  env.world.prs[1].events = [labeledEvent(LABEL, 'praisebuild[bot]', 10), ...filler, labeledEvent(LABEL, 'praisebuild[bot]', 300, 'unlabeled'), labeledEvent(LABEL, 'someone', 301)]
  await tick(env)
  assert.deepEqual(env.store.loadQueue().items, [])
  assert.deepEqual(eventCalls(env).map((c) => c.query.page), ['1', '2'])
})

for (const [name, setup, reason] of [
  ['读 events 返回 403', (world) => { world.eventsStatus = 403 }, /#1 auto_intake_label_actor: 读不到标签 review:merge-ready 的操作者（GET \/repos\/xindong\/mivo-canvas-plugin\/issues\/1\/events\?per_page=100&page=1 -> 403/],
  ['events 超过 10 页读不全', (world) => { world.prs[1].events = Array.from({ length: 1000 }, (_, i) => labeledEvent(LABEL, 'praisebuild[bot]', i + 1)) }, /#1 auto_intake_label_actor: 读不到标签 review:merge-ready 的操作者（issue events 读不全：#1 超过 1000 条）/],
]) {
  test(`#30 SC8 接单时${name}：按不满足处理，不接，记 auto_intake_failed 叫醒伙伴`, async () => {
    const world = paused()
    setup(world)
    const env = await makeMivoEnv({ world, autoIntake: RULE })
    const { events } = await tick(env)
    assert.deepEqual(env.store.loadQueue().items, [])
    assert.match(events.find((e) => e.type === 'auto_intake_failed').reason, reason)
    assert.ok(wakeTypes(events).includes('auto_intake_failed'))
  })
}

for (const [name, setup, reason] of [
  ['标签最近一次由别人补挂', (env) => { env.world.prs[1].events = byActor('someone') }, /^auto_intake_label_actor: 标签 review:merge-ready 最近一次由 someone 挂上，期望 praisebuild\[bot\] 或 PraiseZhu$/],
  ['读 events 失败', (env) => { env.world.eventsStatus = 502 }, /^auto_intake_label_actor: 读不到标签 review:merge-ready 的操作者（.*-> 502/],
  ['条目没有记录 label_actors', (env) => { const q = env.store.loadQueue(); delete q.items[0].autoIntakeLabelActors; env.store.saveQueue(q) }, /^auto_intake_label_actor: 条目没有记录 label_actors$/],
]) {
  test(`#30 SC8 已在队列的自动接单条目，处理时${name}：不合，留在队列，原因 auto_intake_label_actor`, async () => {
    const env = await makeMivoEnv({ world: botWorld() })
    seedMivoItem(env.store, 1, AUTO_ITEM)
    setup(env)
    await tick(env)
    assert.equal(directMerges(env).length, 0)
    assert.equal(item(env).status, 'queued')
    assert.match(item(env).reason, reason)
  })
}

test('#30 SC8 已在队列的自动接单条目，操作者在名单：合并；用户说「合并」接的条目不读 events', async () => {
  const env = await makeMivoEnv({ world: botWorld() })
  seedMivoItem(env.store, 1, AUTO_ITEM)
  await tick(env)
  assert.equal(item(env).status, 'merged')
  assert.equal(eventCalls(env).length, 1)

  const manual = await makeMivoEnv({ world: botWorld() })
  seedMivoItem(manual.store)
  await tick(manual)
  assert.equal(item(manual).status, 'merged')
  assert.equal(eventCalls(manual).length, 0)
})

// SC9 ---------------------------------------------------------------------------------------------
for (const status of [503, 429]) {
  test(`#30 SC9 列表请求失败（${status}）：本轮照常处理已有队列，记 auto_intake_failed 叫醒伙伴`, async () => {
    const world = botWorld({ prs: { 2: { user: { login: 'PraiseZhu' }, labels: [] } }, listStatus: status })
    const env = await makeMivoEnv({ world, autoIntake: RULE })
    seedMivoItem(env.store, 2)
    const { events } = await tick(env)
    assert.equal(item(env, 2).status, 'merged')
    assert.match(events.find((e) => e.type === 'auto_intake_failed').reason, new RegExp(`^列表请求失败（GET /repos/xindong/mivo-canvas-plugin/pulls\\?.* -> ${status}`))
    assert.ok(wakeTypes(events).includes('auto_intake_failed'))
  })
}

test('#30 SC9 同一原因接着失败只记日志不再叫醒；恢复后叫醒一次 auto_intake_recovered，并照常接单', async () => {
  const env = await makeMivoEnv({ world: paused({ listStatus: 503 }), autoIntake: RULE })
  const first = await tick(env)
  const second = await tick(env)
  assert.ok(wakeTypes(first.events).includes('auto_intake_failed'))
  assert.deepEqual(second.events.filter((e) => e.type.startsWith('auto_intake')).map((e) => e.type), ['auto_intake_still_failing'])
  assert.deepEqual(wakeTypes(second.events).filter((t) => t.startsWith('auto_intake')), [])

  delete env.world.listStatus
  const third = await tick(env)
  assert.deepEqual(wakeTypes(third.events).filter((t) => t.startsWith('auto_intake')).sort(), ['auto_intake', 'auto_intake_recovered'])
  assert.equal(env.store.loadLanes()[MIVO].autoIntakeError, undefined)
  assert.equal(item(env).sessionId, AUTO_INTAKE_SESSION)
})

// 复审（2da8754）两条 P2 ------------------------------------------------------------------------------
const intakeTypes = (events) => events.filter((e) => e.type.startsWith('auto_intake')).map((e) => e.type)

for (const withRule of [true, false]) {
  test(`#30 SC8 复审 已入队的自动条目读 events 失败也走失败通知：开始叫醒、同原因只记日志、恢复叫醒（policy ${withRule ? '带' : '不带'} auto_intake）`, async () => {
    const world = botWorld()
    world.eventsStatus = 502
    const env = await makeMivoEnv({ world, ...(withRule ? { autoIntake: RULE } : {}) })
    seedMivoItem(env.store, 1, AUTO_ITEM)

    const first = await tick(env)
    assert.equal(directMerges(env).length, 0)
    assert.match(first.events.find((e) => e.type === 'auto_intake_failed').reason, /^#1 auto_intake_label_actor: 读不到标签 review:merge-ready 的操作者（.*-> 502/)
    assert.ok(wakeTypes(first.events).includes('auto_intake_failed'))

    const second = await tick(env)
    assert.deepEqual(intakeTypes(second.events), ['auto_intake_still_failing'])
    assert.deepEqual(wakeTypes(second.events).filter((t) => t.startsWith('auto_intake')), [])

    // 读得到了，但还有未解决讨论、没合：读取恢复照样报恢复
    delete env.world.eventsStatus
    env.world.threads = [{ isResolved: false }]
    const third = await tick(env)
    assert.equal(item(env).status, 'queued')
    assert.deepEqual(intakeTypes(third.events), ['auto_intake_recovered'])
    assert.ok(wakeTypes(third.events).includes('auto_intake_recovered'))
    assert.equal(item(env).autoIntakeReadError, undefined)
  })
}

test('#30 SC8 复审 读 events 失败的条目这一轮没轮到处理（main CI 还在跑）：不当成恢复，原因保留', async () => {
  const world = botWorld()
  world.eventsStatus = 403
  const env = await makeMivoEnv({ world, autoIntake: RULE })
  seedMivoItem(env.store, 1, AUTO_ITEM)
  await tick(env)
  const reason = env.store.loadLanes()[MIVO].autoIntakeError
  assert.match(reason, /^#1 auto_intake_label_actor/)

  env.world.mainRuns = {} // main 新提交还没有 CI run：车道暂停，条目不处理
  const paused = await tick(env)
  assert.deepEqual(intakeTypes(paused.events), ['auto_intake_still_failing'])
  assert.equal(env.store.loadLanes()[MIVO].autoIntakeError, reason)
})

test('#30 SC9 复审 多个 PR 读 events 失败、列表换了顺序：原因按 PR 号排，同一组错误不重新叫醒', async () => {
  const world = paused({ prs: { 1: {}, 2: {} } })
  world.eventsStatus = 503
  const env = await makeMivoEnv({ world, autoIntake: RULE })
  const first = await tick(env)
  const reason = first.events.find((e) => e.type === 'auto_intake_failed').reason
  assert.match(reason, /^#1 auto_intake_label_actor: .*；#2 auto_intake_label_actor: /)

  env.world.listOrder = [2, 1]
  const second = await tick(env)
  assert.deepEqual(intakeTypes(second.events), ['auto_intake_still_failing'])
  assert.equal(second.events.find((e) => e.type === 'auto_intake_still_failing').reason, reason)
})

test('#30 SC9 复审 接单出错和已入队条目读不到操作者合在一起按 PR 号排；列表请求失败排最前', async () => {
  const world = paused({ prs: { 1: {}, 3: {} } })
  world.eventsStatus = 503
  const env = await makeMivoEnv({ world, autoIntake: RULE })
  const q = env.store.loadQueue()
  q.items.push({ id: `${MIVO}#3`, repo: MIVO, number: 3, status: 'queued', reason: 'queued', after: [], authorizedAt: new Date().toISOString(), headShaAtAuth: MIVO_HEAD, seenHeads: [MIVO_HEAD], ...AUTO_ITEM, autoIntakeReadError: 'auto_intake_label_actor: 读不到（上一轮）' })
  env.store.saveQueue(q)
  env.world.listOrder = [3, 1]
  const { events } = await tick(env)
  assert.match(events.find((e) => e.type === 'auto_intake_failed').reason, /^#1 auto_intake_label_actor: .*；#3 auto_intake_label_actor: 读不到（上一轮）$/)

  env.world.listStatus = 503
  const next = await tick(env)
  assert.match(next.events.find((e) => e.type === 'auto_intake_failed').reason, /^列表请求失败（.*）；#3 auto_intake_label_actor: 读不到（上一轮）$/)
})
