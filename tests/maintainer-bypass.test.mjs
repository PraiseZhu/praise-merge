import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runTick } from '../src/tick.mjs'
import { makeMivoEnv, makeIntegrationWorld, MIVO, MIVO_INT_SHA } from './helpers/fake-mivo.mjs'

const fixtures = [2403, 2432].map((n) => JSON.parse(readFileSync(new URL(`./fixtures/maintainer-bypass/${n}.json`, import.meta.url), 'utf8')))
const RULE = { authors: ['PraiseZhu'], base: ['main', 'integration/*'], label: 'review:merge-ready', label_actors: ['praisebuild[bot]', 'PraiseZhu'], order_line_authors: ['PraiseZhu'] }
const tick = (env) => runTick(env)
const merges = (env) => env.fake.writes().filter((c) => c.path.endsWith('/merge'))
const item = (env) => env.store.loadQueue().items[0]

async function env(fixture = fixtures[0], via = 'comment') {
  const f = structuredClone(fixture)
  const world = makeIntegrationWorld()
  const pr = { rest: { ...f.pr, state: 'open', merged: false, body: '合并顺序：无' }, gql: { id: `PR_${f.pr.number}`, mergeStateStatus: 'CLEAN', mergeQueueEntry: null }, comments: via === 'comment' ? f.comments : [] }
  world.prs = { [f.pr.number]: pr }
  world.notices = via === 'issue' ? [f.issue] : []
  world.integration[f.pr.base.ref] = { sha: MIVO_INT_SHA, runs: { [MIVO_INT_SHA]: { status: 'completed', conclusion: 'success' } } }
  world.checks = [...world.checks.filter((c) => c.name !== 'review-pr (integration)'), ...f.checks]
  return { ...await makeMivoEnv({ world, autoIntake: RULE }), fixture: f, pr }
}

for (const f of fixtures) for (const via of ['comment', 'issue']) {
  test(`#50 SC1 PR #${f.pr.number} ${via} 真实自动放行记录：无标签可接单并合并`, async () => {
    const e = await env(f, via)
    await tick(e)
    assert.equal(merges(e).length, 1)
    assert.equal(merges(e)[0].body.sha, f.pr.head.sha)
    assert.equal(item(e).headShaAtAuth, f.pr.head.sha)
    assert.equal(item(e).status, 'merged')
  })
}

for (const [name, change] of [
  ['普通检查成功，没有放行记录', (e) => { e.pr.comments = [] }],
  ['评论由别人复制', (e) => { e.pr.comments[0].user.login = 'someone' }],
  ['评论不是 protected 放行', (e) => { e.pr.comments[0].body = '<!-- review-pr:product-gate kind=arch issue=https://github.com/xindong/mivo-canvas-plugin/issues/2408 -->' }],
  ['评论链接到别的仓', (e) => { e.pr.comments[0].body = e.pr.comments[0].body.replaceAll(MIVO, 'other/repo') }],
  ['通知 issue 由别人复制', (e) => { e.pr.comments = []; e.world.notices = [{ ...e.fixture.issue, user: { login: 'someone', type: 'User' } }] }],
  ['通知是待确认，不是自动放行', (e) => { e.pr.comments = []; e.world.notices = [{ ...e.fixture.issue, body: e.fixture.issue.body.replace('signoff-mode=notice', 'signoff-mode=approval') }] }],
  ['通知不是 protected', (e) => { e.pr.comments = []; e.world.notices = [{ ...e.fixture.issue, body: e.fixture.issue.body.replace('**protected**', '**product**') }] }],
  ['通知关联别的 PR', (e) => { e.pr.comments = []; e.world.notices = [{ ...e.fixture.issue, body: e.fixture.issue.body.replaceAll('/pull/2403', '/pull/24030') }] }],
  ['通知标题是另一个 PR', (e) => { e.pr.comments = []; e.world.notices = [{ ...e.fixture.issue, title: '维护者确认 · PR #24030 标题' }] }],
  ['PR 作者不是维护者', (e) => { e.pr.rest.user = { login: 'praise-qa[bot]' }; e.policy.repos[MIVO].autoIntake.authors.push('praise-qa[bot]') }],
]) test(`#50 SC2 ${name}：无标签不合`, async () => {
  const e = await env()
  change(e)
  await tick(e)
  assert.equal(merges(e).length, 0)
  assert.equal(item(e), undefined)
})

for (const [name, change] of [
  ['仅旧 head 有成功检查', (e) => { const old = e.pr.rest.head.sha; e.pr.rest.head = { sha: 'e'.repeat(40) }; e.world.branchChecks[old] = e.world.checks; e.world.checks = e.world.checks.filter((c) => c.name !== 'review-pr (integration)') }],
  ['当前检查缺失', (e) => { e.world.checks = e.world.checks.filter((c) => c.name !== 'review-pr (integration)') }],
  ['检查失败', (e) => { e.world.checks.at(-1).conclusion = 'failure' }],
  ['检查跳过', (e) => { e.world.checks.at(-1).conclusion = 'skipped' }],
  ['写入 App 不符', (e) => { e.world.checks.at(-1).app.id = 999 }],
  ['返回的检查 head 不符', (e) => { e.world.checks.at(-1).head_sha = 'b'.repeat(40) }],
  ['同名较新检查仍在跑', (e) => { e.world.checks.push({ ...e.world.checks.at(-1), id: 999999999999, status: 'in_progress', conclusion: null }) }],
]) test(`#50 SC3 ${name}：不合`, async () => {
  const e = await env()
  change(e)
  await tick(e)
  assert.equal(merges(e).length, 0)
})

for (const [name, change] of [
  ['另一个必需检查失败', (e) => { e.world.checks[0].conclusion = 'failure' }],
  ['讨论没解决', (e) => { e.world.threads = [{ isResolved: false }] }],
  ['不是 CLEAN', (e) => { e.pr.gql.mergeStateStatus = 'BLOCKED' }],
  ['依赖尚未合入', (e) => { e.pr.rest.body = '合并顺序：等 #2 合入后'; e.world.prs[2] = { rest: { ...e.pr.rest, number: 2, draft: true }, gql: {} } }],
  ['写前 head 改变', (e) => { e.pr.restOnReread = { head: { sha: 'e'.repeat(40) } } }],
  ['评论读取失败', (e) => { e.world.commentsStatus = 502 }],
  ['评论分页读不全', (e) => { e.pr.comments = Array(1000).fill(e.pr.comments[0]) }],
  ['issue 搜索读取失败', (e) => { e.pr.comments = []; e.world.noticeSearchStatus = 403 }],
  ['issue 搜索结果不完整', (e) => { e.pr.comments = []; e.world.notices = [e.fixture.issue]; e.world.noticeSearchIncomplete = true }],
]) test(`#50 SC4 ${name}：不合`, async () => {
  const e = await env()
  change(e)
  await tick(e)
  assert.equal(merges(e).length, 0)
})

test('#50 SC4 已接单后换 head，即使新 head 检查成功也不能沿用旧授权', async () => {
  const e = await env()
  e.world.threads = [{ isResolved: false }]
  await tick(e)
  assert.ok(item(e))
  e.world.threads = []
  e.pr.rest.head = { sha: 'e'.repeat(40) }
  e.world.checks.at(-1).head_sha = e.pr.rest.head.sha
  await tick(e)
  assert.equal(merges(e).length, 0)
})

test('#50 SC1 main 上使用 review-pr 检查也可自动放行', async () => {
  const e = await env()
  e.pr.rest.base.ref = 'main'
  e.world.checks = e.world.checks.map((c) => c.name === 'review-pr (integration)' ? { ...c, name: 'review-pr' } : c)
  await tick(e)
  assert.equal(merges(e).length, 1)
})

test('#50 SC2 旧通知仍在，但当前检查来自普通审查：不合', async () => {
  const e = await env()
  e.world.checks.at(-1).output = { title: '审查通过', summary: '没有 P0/P1/P2' }
  await tick(e)
  assert.equal(merges(e).length, 0)
  assert.equal(item(e), undefined)
})

test('#50 SC2 放行输出的维护者凭据不是当前作者：不合', async () => {
  const e = await env()
  e.world.checks.at(-1).output.summary = 'author-maintainer:someone'
  await tick(e)
  assert.equal(merges(e).length, 0)
})

for (const [name, change] of [
  ['通知被撤掉', (e) => { e.pr.comments = [] }],
  ['审查检查重新变红', (e) => { e.world.checks.at(-1).conclusion = 'failure' }],
]) test(`#50 SC4 门禁检查后写入前${name}：不合`, async () => {
  const e = await env()
  const original = e.client.request
  e.client.request = async (...args) => {
    const result = await original(...args)
    if (args[1] === `/repos/${MIVO}/pulls/${e.pr.rest.number}` && e.pr.reads === 2) change(e)
    return result
  }
  await tick(e)
  assert.equal(merges(e).length, 0)
  assert.match(item(e).reason, /pr_changed_before_write: auto_intake_maintainer_bypass/)
})

for (const via of ['comment', 'issue']) test(`#50 SC4 ${via} 放行记录在第 2 页：完整读取后合并`, async () => {
  const e = await env(fixtures[0], via)
  if (via === 'comment') e.pr.comments = [...Array(100).fill({ body: 'other' }), ...e.pr.comments]
  else e.world.notices = [...Array(100).fill({ title: 'other' }), ...e.world.notices]
  await tick(e)
  assert.equal(merges(e).length, 1)
  assert.ok(e.fake.calls.some((c) => c.path === (via === 'comment' ? `/repos/${MIVO}/issues/2403/comments` : '/search/issues') && c.query.page === '2'))
})

test('#50 SC4 issue 搜索超过可完整读取的 1000 条：不合', async () => {
  const e = await env(fixtures[0], 'issue')
  e.world.notices = Array(1001).fill(e.fixture.issue)
  await tick(e)
  assert.equal(merges(e).length, 0)
  assert.equal(item(e), undefined)
})

test('#50 SC4 放行证据读失败进入已有告警通道，恢复后接单合并', async () => {
  const e = await env()
  e.world.commentsStatus = 502
  const failed = await tick(e)
  assert.ok(failed.events.some((ev) => ev.type === 'auto_intake_failed' && ev.reason.includes('读不到完整放行证据')))
  delete e.world.commentsStatus
  const recovered = await tick(e)
  assert.equal(merges(e).length, 1)
  assert.ok(recovered.events.some((ev) => ev.type === 'auto_intake_recovered'))
})

test('#50 SC4 合并队列入队前也重验授权 head', async () => {
  const e = await env()
  e.world.mergeQueue = { id: 'MQ_1' }
  e.pr.restOnReread = { head: { sha: 'e'.repeat(40) } }
  await tick(e)
  assert.equal(e.fake.writes().length, 0)
  assert.match(item(e).reason, /pr_changed_before_write: head/)
})

test('#50 SC4 影子模式识别放行但不发送写请求', async () => {
  const e = await env()
  e.shadow = true
  const result = await tick(e)
  assert.equal(e.fake.writes().length, 0)
  assert.ok(result.events.some((ev) => ev.type === 'would_merge'))
})
