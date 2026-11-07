// #22：证据写入方从逐条列表接口读；PraiseZhu/* 默认条目与 required_checks = "all"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { enqueueRequest } from '../src/enqueue.mjs'
import { SCHEMA } from '../src/request.mjs'
import { toPolicy, selectRepoPolicy } from '../src/policy.mjs'
import { toPatchId } from '../src/patch-id.mjs'
import { makeEnv, makeWorld, makePr, seedItem, evidenceStatus, authStatus, passingRun, HEAD, DIFF, REPO } from './helpers/fake-github.mjs'

const PATCH = toPatchId(DIFF)
const MIN = 60_000
const item = (env) => env.store.loadQueue().items[0]
const mergeCalls = (env) => env.fake.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge'))
const fullEvidence = () => [authStatus(PATCH), evidenceStatus(PATCH), evidenceStatus(PATCH, { id: 101, context: 'praise-merge/e2e' })]

const DEFAULT_ONLY = { 'PraiseZhu/*': { lane: 'personal', required_checks: 'all', e2e: 'required' } }
const WITH_REPO = { ...DEFAULT_ONLY, 'PraiseZhu/demo': { lane: 'personal', required_checks: ['verify'], e2e: 'required' } }

async function runWith(worldOverrides, { repos = DEFAULT_ONLY, passEvidence = false, now = Date.now() } = {}) {
  const env = await makeEnv({ world: makeWorld(worldOverrides), shadow: false, passEvidence })
  env.policy = toPolicy({ repos })
  seedItem(env.store)
  await runTick({ ...env, now })
  return env
}

// SC1 ---------------------------------------------------------------------------------------------
test('#22 SC1 汇总接口的 status 不带 creator；三样证据都由 PraiseZhu 写入时证据门禁通过', async () => {
  const env = await runWith({ statuses: { [HEAD]: fullEvidence() } })
  const combined = await (await env.fake.fetchImpl(`https://api.github.com/repos/${REPO}/commits/${HEAD}/status`)).json()
  assert.ok(combined.statuses.length === 3 && combined.statuses.every((st) => !('creator' in st)))
  assert.ok(env.fake.calls.some((c) => c.path === `/repos/${REPO}/commits/${HEAD}/statuses`))
  assert.equal(mergeCalls(env).length, 1)
})

test('#22 SC1 最新一条证据由别的账号写入：不合，原因写出实际写入方', async () => {
  const newer = evidenceStatus(PATCH, { id: 150, creator: { login: 'mallory' } })
  const env = await runWith({ statuses: { [HEAD]: [...fullEvidence(), newer] } })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /gpt-review: 写入方期望 PraiseZhu，实际 mallory/)
})

test('#22 SC1 逐条列表读不全、对不上证据的写入方：门禁按失败处理，不合', async () => {
  const fillers = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, context: `ci/other-${i}`, state: 'success', creator: { login: 'bot' }, description: '' }))
  const env = await runWith({ statusListPageLimit: 1, statuses: { [HEAD]: [...fillers, ...fullEvidence()] } }, { repos: WITH_REPO })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /commit status 写入方读不全：aaaaaaaa 共 103 个 context，只对上 100 个/)
})

// SC2 ---------------------------------------------------------------------------------------------
const request = (prs) => ({ schema: SCHEMA, session_id: 's1', authorized_at: new Date().toISOString(), authorization_text: '合并', prs })

test('#22 SC2 只有 PraiseZhu/* 默认条目：任意 PraiseZhu 仓都能接单；排除仓照旧拒收', async () => {
  const policy = toPolicy({ repos: DEFAULT_ONLY })
  assert.equal(selectRepoPolicy(policy, 'PraiseZhu/panoptes').name, 'PraiseZhu/*')
  assert.equal(selectRepoPolicy(policy, 'praisezhu/Approve-Exec').requiredChecks, 'all')
  assert.equal(selectRepoPolicy(policy, 'PraiseZhu/panoptes').e2e, 'required')
  for (const repo of ['makecindy/cindy', 'xindong/mivo-canvas', 'xindong/XDMaker', 'someone/else']) assert.equal(selectRepoPolicy(policy, repo), null, repo)

  const world = makeWorld()
  world.repos['praisezhu/new-repo'] = { ...world.repos[REPO], prs: { 4: makePr({ number: 4 }) } }
  const env = await makeEnv({ world })
  const result = await enqueueRequest({ store: env.store, policy, clientFor: env.clientFor, request: request([
    { repo: 'PraiseZhu/new-repo', number: 4, head_sha_at_auth: HEAD },
    { repo: 'makecindy/cindy', number: 9, head_sha_at_auth: HEAD },
    { repo: 'xindong/mivo-canvas', number: 9, head_sha_at_auth: HEAD },
  ]) })
  assert.deepEqual(result.accepted, ['praisezhu/new-repo#4'])
  assert.deepEqual(result.rejected.map((r) => [r.id, r.reason]), [['makecindy/cindy#9', 'repo_excluded'], ['xindong/mivo-canvas#9', 'repo_excluded']])
  assert.deepEqual(env.fake.writes(), [])
})

test('#22 SC2 逐仓条目优先于默认条目', async () => {
  const policy = toPolicy({ repos: WITH_REPO })
  assert.deepEqual(selectRepoPolicy(policy, 'PraiseZhu/demo').requiredChecks, ['verify'])
  assert.equal(selectRepoPolicy(policy, 'PraiseZhu/other').requiredChecks, 'all')
  assert.deepEqual(Object.keys(policy.repos), ['praisezhu/demo']) // 默认条目不算进逐仓列表（doctor 按它核对安装范围）

  // head 上 lint 失败但逐仓条目只要求 verify：按逐仓条目合并；只有默认条目时按 all 不合
  const checks = { [HEAD]: [passingRun('verify'), { ...passingRun('lint', 2), conclusion: 'failure' }] }
  assert.equal(mergeCalls(await runWith({ checks }, { repos: WITH_REPO, passEvidence: true })).length, 1)
  const env = await runWith({ checks }, { passEvidence: true })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /lint=failure/)
})

for (const [name, repos, message] of [
  ['别的 owner 的通配条目', { 'xindong/*': { lane: 'personal', required_checks: 'all' } }, /通配条目只支持 PraiseZhu\/\*，实际 xindong\/\*/],
  ['mivo 车道的通配条目', { 'PraiseZhu/*': { lane: 'mivo', required_checks: ['verify'] } }, /PraiseZhu\/\* 是通配条目，lane 只能是 personal，实际 mivo/],
  ['默认条目不要 e2e', { 'PraiseZhu/*': { lane: 'personal', required_checks: 'all', e2e: 'n_a' } }, /PraiseZhu\/\* 是通配条目，e2e 必须是 required/],
  ['mivo 车道写 all', { 'xindong/mivo-canvas-plugin': { lane: 'mivo', required_checks: 'all' } }, /xindong\/mivo-canvas-plugin\.required_checks 写 "all" 只能用于 personal 车道/],
  ['required_checks 写成别的字符串', { 'PraiseZhu/*': { lane: 'personal', required_checks: 'verify' } }, /PraiseZhu\/\*\.required_checks 至少一项，或写 "all"/],
  ['通配写在仓名中间', { 'PraiseZhu/foo*': { lane: 'personal', required_checks: 'all' } }, /policy 仓名格式不对: PraiseZhu\/foo\*/],
]) {
  test(`#22 SC2 加载配置时报错：${name}`, () => {
    assert.throws(() => toPolicy({ repos }), message)
  })
}

// SC3 ---------------------------------------------------------------------------------------------
test('#22 SC3 required_checks = all：任一非证据检查失败或还在跑就不合，原因列出名字和状态', async () => {
  const env = await runWith({
    checks: { [HEAD]: [passingRun('verify'), { ...passingRun('lint', 2), conclusion: 'failure' }, { id: 3, name: 'build', status: 'in_progress', conclusion: null }] },
    statuses: { [HEAD]: [{ id: 50, context: 'ci/legacy', state: 'pending', creator: { login: 'bot' }, description: '' }] },
  }, { passEvidence: true })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /required_checks: 必需检查未通过（all）: lint=failure, build=in_progress, ci\/legacy=pending/)
})

test('#22 SC3 required_checks = all：非证据检查全部通过就放行，praise-merge/* 证据 status 不算在内', async () => {
  const env = await runWith({
    checks: { [HEAD]: [passingRun('verify'), passingRun('lint', 2)] },
    statuses: { [HEAD]: [{ id: 50, context: 'ci/legacy', state: 'success', creator: { login: 'bot' }, description: '' }, evidenceStatus(PATCH, { state: 'failure' })] },
  }, { passEvidence: true })
  assert.equal(mergeCalls(env).length, 1)
})

test('#22 SC3 required_checks = all 与证据门禁一起：证据齐全、检查全过时合并', async () => {
  const env = await runWith({ checks: { [HEAD]: [passingRun('verify')] }, statuses: { [HEAD]: fullEvidence() } })
  assert.equal(mergeCalls(env).length, 1)
})

// SC4 ---------------------------------------------------------------------------------------------
const noCi = (pushedMinutesAgo, now) => ({
  prs: { 1: makePr({ head: { sha: HEAD, ref: 'feat/x' } }) },
  checks: {},
  statuses: { [HEAD]: fullEvidence() },
  pushes: pushedMinutesAgo === null ? [] : [
    { ref: 'refs/heads/feat/x', after: HEAD, timestamp: new Date(now - pushedMinutesAgo * MIN).toISOString() },
    { ref: 'refs/heads/feat/x', after: 'c'.repeat(40), timestamp: new Date(now - 60 * MIN).toISOString() },
  ],
})

test('#22 SC4 head 上一项检查都没有、推送不满 10 分钟：留在队列，原因写明在等 CI', async () => {
  const now = Date.now()
  const env = await runWith(noCi(9, now), { now })
  assert.equal(mergeCalls(env).length, 0)
  assert.equal(item(env).status, 'queued')
  assert.match(item(env).reason, /required_checks: head 上还没有任何检查，等 CI 出现（head aaaaaaaa 推送于 .*满 10 分钟仍没有检查才放行）/)
  const activity = env.fake.calls.find((c) => c.path === `/repos/${REPO}/activity`)
  assert.equal(activity.query.ref, 'refs/heads/feat/x')
})

test('#22 SC4 head 上一项检查都没有、推送满 10 分钟：放行', async () => {
  const now = Date.now()
  const env = await runWith(noCi(10, now), { now })
  assert.equal(mergeCalls(env).length, 1)
})

test('#22 SC4 读不到 head 的推送时间：不合，原因写清楚', async () => {
  const now = Date.now()
  const env = await runWith(noCi(null, now), { now })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /required_checks: gate_error: 读不到 head aaaaaaaa 的推送时间/)
})

// GPT 单审第一轮（623c16d）的两条 --------------------------------------------------------------------
test('#22 审查修复 同名 check run 成功、commit status 失败：all 不合，原因写明来源；逐仓条目照旧 check run 优先', async () => {
  const world = {
    checks: { [HEAD]: [passingRun('verify'), passingRun('ci/lint', 2)] },
    statuses: { [HEAD]: [{ id: 50, context: 'ci/lint', state: 'failure', creator: { login: 'bot' }, description: '' }] },
  }
  const env = await runWith(world, { passEvidence: true })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /必需检查未通过（all）: ci\/lint（commit status）=failure$/)

  const perRepo = await runWith(world, { repos: { 'PraiseZhu/demo': { lane: 'personal', required_checks: ['ci/lint'] } }, passEvidence: true })
  assert.equal(mergeCalls(perRepo).length, 1)
})

test('#22 审查修复 check run 超过 10 页读不全：门禁按失败处理，不合', async () => {
  const runs = Array.from({ length: 1001 }, (_, i) => passingRun(`ci/job-${i}`, i + 1))
  runs[1000] = { ...runs[1000], conclusion: 'failure' }
  const env = await runWith({ checks: { [HEAD]: runs } }, { passEvidence: true })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /required_checks: gate_error: check run 读不全：aaaaaaaa 共 1001 个，只读到 1000 个/)
})
