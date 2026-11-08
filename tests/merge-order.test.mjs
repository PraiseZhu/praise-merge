// #38：本人 Mivo PR 自动接单，按 PR 正文「合并顺序：」排队
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { toPolicy } from '../src/policy.mjs'
import { toEventLines } from '../src/events.mjs'
import { toMergeOrder } from '../src/merge-order.mjs'
import { ORDER_INTAKE_TEXT } from '../src/auto-intake.mjs'
import { makeMivoEnv, makeMivoWorld, labeledEvent, MIVO, MIVO_CHECKS, MIVO_HEAD } from './helpers/fake-mivo.mjs'

const ME = 'PraiseZhu'
const BOT = 'praise-qa[bot]'
const LABEL = 'review:merge-ready'
const RULE = { authors: [BOT, ME], label: LABEL, base: 'main', label_actors: ['praisebuild[bot]', ME], order_line_authors: [ME] }
const id = (n, repo = MIVO) => `${repo}#${n}`
const tick = (env) => runTick({ ...env, now: Date.now() })
const item = (env, n) => env.store.loadQueue().items.find((it) => it.number === n)
const merges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path)).map((c) => Number(c.path.match(/pulls\/(\d+)/)[1]))
const typed = (events, type) => events.filter((e) => e.type === type)

const pr = (number, body, patch = {}) => ({
  rest: { number, state: 'open', merged: false, draft: false, user: { login: ME }, base: { ref: 'main' }, head: { sha: MIVO_HEAD }, labels: [{ name: LABEL }], body, ...patch },
  gql: { id: `PR_${number}`, mergeStateStatus: 'CLEAN', mergeQueueEntry: null },
})
function world(prs) {
  const w = makeMivoWorld({ mergeQueue: null })
  w.prs = prs
  return w
}
const env = (prs, opts = {}) => makeMivoEnv({ world: world(prs), autoIntake: RULE, ...opts })

// SC1 ---------------------------------------------------------------------------------------------
test('#38 SC1 解析：无 / 无依赖 → 没有依赖；#号和 owner/repo#号都是依赖，#号指本仓', () => {
  assert.deepEqual(toMergeOrder('任务 issue：a/b#1\n合并顺序：无\n', MIVO, 5), { ok: true, after: [] })
  assert.deepEqual(toMergeOrder('合并顺序：无依赖（独立改动）', MIVO, 5), { ok: true, after: [] })
  assert.deepEqual(toMergeOrder('- 合并顺序: 等 #12、xindong/Mivo-Canvas-Plugin#13 合入后', MIVO, 5), { ok: true, after: [id(12), id(13)] })
  assert.deepEqual(toMergeOrder('合并顺序：等 PraiseZhu/praise-merge#7 合入', MIVO, 5), { ok: true, after: ['praisezhu/praise-merge#7'] })
  assert.deepEqual(toMergeOrder('<!-- 合并顺序：等 #9 -->\n合并顺序：无', MIVO, 5), { ok: true, after: [] }, 'HTML 注释里的不算')
})

test('#38 SC1 解析：缺行、多行、看不懂、依赖自己都无效，原因可读', () => {
  assert.match(toMergeOrder('任务 issue：a/b#1', MIVO, 5).reason, /缺少「合并顺序：」一行/)
  assert.match(toMergeOrder(null, MIVO, 5).reason, /缺少/)
  assert.match(toMergeOrder('合并顺序：无\n合并顺序：等 #3', MIVO, 5).reason, /有 2 行/)
  assert.match(toMergeOrder('合并顺序：等那个 PR 先合', MIVO, 5).reason, /看不懂/)
  assert.match(toMergeOrder('合并顺序：等 #5', MIVO, 5).reason, /依赖了自己/)
})

// SC2 ---------------------------------------------------------------------------------------------
test('#38 SC2 policy：order_line_authors 不是 authors 子集时报错，带条目名；合法时解析出来', () => {
  const load = (rule) => toPolicy({ repos: { [MIVO]: { lane: 'mivo', required_checks: MIVO_CHECKS, auto_intake: rule } } })
  assert.throws(() => load({ ...RULE, authors: [BOT] }), new RegExp(`${MIVO}\\.auto_intake\\.order_line_authors 只能是 authors 里的账号.*实际 PraiseZhu`))
  assert.throws(() => load({ ...RULE, order_line_authors: 'PraiseZhu' }), /order_line_authors 应为数组/)
  assert.deepEqual(load(RULE).repos[MIVO].autoIntake.orderLineAuthors, [ME])
})

// SC3 ---------------------------------------------------------------------------------------------
test('#38 SC3 本人 PR 合并顺序有效 → 接单并合并；接单记录写明按正文', async () => {
  const e = await env({ 1: pr(1, '合并顺序：无') })
  await tick(e)
  assert.equal(item(e, 1).status, 'merged')
  assert.equal(item(e, 1).authorizationText, ORDER_INTAKE_TEXT)
  assert.equal(item(e, 1).orderFromBody, true)
})

test('#38 SC3 本人 PR 没写合并顺序 → 不接单，发一次 merge_order_invalid（叫醒），下一轮同一原因不再发；补好后接单', async () => {
  const e = await env({ 1: pr(1, '任务 issue：x/y#1') })
  const first = await tick(e)
  assert.equal(item(e, 1), undefined)
  assert.equal(typed(first.events, 'merge_order_invalid').length, 1)
  assert.equal(toEventLines(first.events).filter((l) => l.includes('merge_order_invalid')).length, 1)
  const second = await tick(e)
  assert.equal(typed(second.events, 'merge_order_invalid').length, 0)
  e.world.prs[1].rest.body = '合并顺序：无'
  await tick(e)
  assert.equal(item(e, 1).status, 'merged')
})

test('#38 SC3 head 变了原因相同也再报一次；bot PR 不要求合并顺序行', async () => {
  const e = await env({ 1: pr(1, ''), 2: pr(2, '', { user: { login: BOT } }) })
  const first = await tick(e)
  assert.deepEqual(typed(first.events, 'merge_order_invalid').map((ev) => ev.pr), [1])
  assert.equal(item(e, 2).status, 'merged')
  e.world.prs[1].rest.head = { sha: 'e'.repeat(40) }
  const again = await tick(e)
  assert.deepEqual(typed(again.events, 'merge_order_invalid').map((ev) => ev.pr), [1])
})

// SC4 ---------------------------------------------------------------------------------------------
test('#38 SC4 依赖还开着：不合，原因写等谁，不叫醒；依赖合入后再合', async () => {
  const e = await env({ 1: pr(1, '合并顺序：等 #2 合入后', { labels: [{ name: LABEL }] }), 2: pr(2, '合并顺序：无', { labels: [] }) })
  const first = await tick(e)
  assert.deepEqual(merges(e), [])
  assert.equal(item(e, 1).reason, `等依赖合入: ${id(2)}`)
  assert.equal(typed(first.events, 'merge_order_blocked').length, 0)
  Object.assign(e.world.prs[2].rest, { merged: true, state: 'closed' })
  await tick(e)
  assert.deepEqual(merges(e), [1])
})

test('#38 SC4 依赖在队列里先合：同一 PR 链按顺序合，后一个等前一个', async () => {
  const e = await env({ 1: pr(1, '合并顺序：等 #2'), 2: pr(2, '合并顺序：无') })
  await tick(e)
  assert.deepEqual(merges(e), [2])
  await tick(e)
  assert.deepEqual(merges(e), [2, 1])
})

test('#38 SC4 依赖关闭未合入：不合，发一次 merge_order_blocked；原因不变不重复报', async () => {
  const e = await env({ 1: pr(1, '合并顺序：等 #2'), 2: pr(2, '合并顺序：无', { state: 'closed', labels: [] }) })
  const first = await tick(e)
  assert.deepEqual(merges(e), [])
  const blocked = typed(first.events, 'merge_order_blocked')
  assert.equal(blocked.length, 1)
  assert.match(blocked[0].reason, /依赖 xindong\/mivo-canvas-plugin#2 已关闭但没有合入/)
  const second = await tick(e)
  assert.equal(typed(second.events, 'merge_order_blocked').length, 0)
})

test('#38 SC4 读不到依赖（不在安装范围）：不合，merge_order_blocked', async () => {
  const e = await env({ 1: pr(1, '合并顺序：等 other/repo#3') })
  const base = e.clientFor
  e.clientFor = (repo) => { if (repo === 'other/repo') throw new Error('app.json 里没有 other 的安装 ID'); return base(repo) }
  const res = await tick(e)
  assert.deepEqual(merges(e), [])
  assert.match(typed(res.events, 'merge_order_blocked')[0].reason, /读不到依赖 other\/repo#3/)
})

test('#38 SC4 接单后正文改了：按最新依赖判断；改成无效也不合', async () => {
  const e = await env({ 1: pr(1, '合并顺序：等 #2'), 2: pr(2, '合并顺序：无', { labels: [] }) })
  await tick(e)
  assert.deepEqual(merges(e), [])
  e.world.prs[1].rest.body = '合并顺序：无'
  await tick(e)
  assert.deepEqual(merges(e), [1])

  const f = await env({ 1: pr(1, '合并顺序：等 #2'), 2: pr(2, '合并顺序：无', { labels: [] }) })
  await tick(f)
  f.world.prs[1].rest.body = '没有这一行了'
  const res = await tick(f)
  assert.deepEqual(merges(f), [])
  assert.match(typed(res.events, 'merge_order_blocked')[0].reason, /缺少「合并顺序：」一行/)
})

// SC5 ---------------------------------------------------------------------------------------------
test('#38 SC5 门禁不放松：标签不是审查机挂的不接；检查没过不合', async () => {
  const p = pr(1, '合并顺序：无')
  p.rest.events = undefined
  const e = await env({ 1: { ...p, events: [labeledEvent(LABEL, 'someone', 50)] } })
  await tick(e)
  assert.equal(item(e, 1), undefined)

  const f = await env({ 1: pr(1, '合并顺序：无') })
  f.world.checks = f.world.checks.map((c, i) => (i === 0 ? { ...c, conclusion: 'failure' } : c))
  await tick(f)
  assert.deepEqual(merges(f), [])
  assert.match(item(f, 1).reason, /required_checks/)
})

// SC6 ---------------------------------------------------------------------------------------------
test('#38 SC6 影子模式：照常接单和判断顺序，写请求 0', async () => {
  const e = await env({ 1: pr(1, '合并顺序：无'), 2: pr(2, '') }, { shadow: true })
  const res = await tick(e)
  assert.equal(e.fake.writes().length, 0)
  assert.ok(res.events.some((ev) => ev.type === 'would_auto_intake' && ev.pr === 1))
  assert.ok(res.events.some((ev) => ev.type === 'would_merge' && ev.pr === 1))
  assert.equal(typed(res.events, 'merge_order_invalid').length, 1)
})

// 审查 P2 -----------------------------------------------------------------------------------------
test('#38 审查 P2 用户说「合并」指定的依赖：依赖关闭后 head 变了被自动重接单，正文写「无」也不能清掉，依赖没合入就不合', async () => {
  const { seedMivoItem } = await import('./helpers/fake-mivo.mjs')
  const e = await env({ 1: pr(1, '合并顺序：无'), 2: pr(2, '合并顺序：无', { state: 'closed', labels: [] }) })
  seedMivoItem(e.store, 1, { after: [id(2)] })
  seedMivoItem(e.store, 2, { status: 'closed', reason: 'pr_closed' })
  await tick(e)
  assert.equal(item(e, 1).status, 'blocked_by_dependency')
  e.world.prs[1].rest.head = { sha: 'e'.repeat(40) }
  const res = await tick(e)
  assert.deepEqual(merges(e), [], '用户指定的依赖 #2 没合入，不能合')
  assert.equal(item(e, 1).orderFromBody, true)
  assert.deepEqual(item(e, 1).pinnedAfter, [id(2)])
  assert.match(typed(res.events, 'merge_order_blocked')[0].reason, /依赖 xindong\/mivo-canvas-plugin#2 已关闭但没有合入/)
})
