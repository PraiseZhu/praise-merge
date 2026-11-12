// #48：main 或在用的集成分支当前提交 CI 变红时发 main_ci_red / integration_ci_red，由伙伴用飞书通知用户；
// 同一分支同一提交只发一次，集成分支转绿发一次 integration_ci_recovered。还在跑、读不到、来源未知不算红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runTick } from '../src/tick.mjs'
import { toEventLines } from '../src/events.mjs'
import { toPartnerMessage, FEISHU_LINE } from '../scripts/cindy-tick.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, seedMivoItem, greenBranchChecks, MIVO, MIVO_MAIN, MIVO_INT, MIVO_INT_SHA, ACTIONS_APP } from './helpers/fake-mivo.mjs'

const tick = (env) => runTick({ ...env, now: Date.now() })
const ofType = (events, type) => events.filter((e) => e.type === type)
const run = (id, name, status = 'completed', conclusion = status === 'completed' ? 'success' : null) => ({ id, name, status, conclusion, app: ACTIONS_APP, check_suite: { id: 7001 } })
const CODEQL = 'Analyze (javascript-typescript)'
const INT_Y = 'integration/y'
const INT_Y_SHA = '8'.repeat(40)
const branchReads = (env, branch) => env.fake.calls.filter((c) => c.method === 'GET' && c.path === `/repos/${MIVO}/branches/${encodeURIComponent(branch)}`)
const ciRunReads = (env, branch) => env.fake.calls.filter((c) => c.path === `/repos/${MIVO}/actions/workflows/ci.yml/runs` && c.query.branch === branch)
const checkReads = (env, sha) => env.fake.calls.filter((c) => c.path === `/repos/${MIVO}/commits/${sha}/check-runs`)
const lastChecked = (env, n) => env.store.loadQueue().items.find((it) => it.number === n)?.lastCheckedAt

// 只排一个合进 main 的条目（PR #2），集成分支上没有排队条目
async function envWith(world, opts = {}) {
  const env = await makeMivoEnv({ world, ...opts })
  seedMivoItem(env.store, 2)
  return env
}

// SC1

test('#48 SC1 main 当前提交 ci.yml 失败：本轮发一次 main_ci_red（带提交前 8 位和失败项），同一提交下一轮不再发', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.mainRuns[MIVO_MAIN] = { status: 'completed', conclusion: 'failure' }
  const env = await envWith(world)
  const first = (await tick(env)).events
  assert.deepEqual(ofType(first, 'main_ci_red'), [{ type: 'main_ci_red', repo: MIVO, branch: 'main', head: MIVO_MAIN, reason: 'main aaaaaaaa CI=failure' }])
  assert.ok(ofType(first, 'lane_paused').length === 1, '车道照常暂停')
  assert.ok(toEventLines(first).some((line) => JSON.parse(line).type === 'main_ci_red' && JSON.parse(line).branch === 'main'), '叫醒伙伴的行里带 branch')
  assert.deepEqual(ofType((await tick(env)).events, 'main_ci_red'), [], '同一提交不再发')
  assert.deepEqual(env.fake.writes(), [])
})

test('#48 SC1 main 的 ci.yml 还在跑：只暂停，不发 main_ci_red', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.mainRuns[MIVO_MAIN] = { status: 'in_progress', conclusion: null }
  const env = await envWith(world)
  const events = (await tick(env)).events
  assert.equal(ofType(events, 'lane_paused').length, 1)
  assert.deepEqual(ofType(events, 'main_ci_red'), [])
})

test('#48 SC1 main 换了新提交又红：新提交再发一次；转绿后同一提交重跑又红也再发', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.mainRuns[MIVO_MAIN] = { status: 'completed', conclusion: 'failure' }
  const env = await envWith(world)
  assert.equal(ofType((await tick(env)).events, 'main_ci_red').length, 1)
  const next = 'b'.repeat(40)
  world.mainSha = next
  world.mainRuns[next] = { status: 'completed', conclusion: 'failure' }
  assert.deepEqual(ofType((await tick(env)).events, 'main_ci_red').map((e) => e.head), [next])
})

// SC2

test('#48 SC2 main 的 ci.yml 成功但 push 触发的 CodeQL 失败：发 main_ci_red，原因列出失败项', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.branchChecks[MIVO_MAIN] = [...greenBranchChecks(), run(910, CODEQL, 'completed', 'failure')]
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'main_ci_red')
  assert.equal(red.length, 1)
  assert.equal(red[0].reason, `main aaaaaaaa ${CODEQL}=failure`)
})

test('#48 SC2 只有还在跑的检查、或来源未知的检查：只暂停，不发 main_ci_red', async () => {
  for (const extra of [run(911, 'Analyze (python)', 'in_progress'), { ...run(912, 'mystery', 'completed', 'failure'), check_suite: { id: 9999 } }]) {
    const world = makeMivoWorld({ mergeQueue: null })
    world.branchChecks[MIVO_MAIN] = [...greenBranchChecks(), extra]
    const env = await envWith(world)
    const events = (await tick(env)).events
    assert.equal(ofType(events, 'lane_paused').length, 1, extra.name)
    assert.deepEqual(ofType(events, 'main_ci_red'), [], extra.name)
  }
})

// SC3

test('#48 SC3 在用的集成分支 ci.yml 失败：main 暂停、分支上没有排队条目时也发 integration_ci_red；同一提交只发一次；重跑转绿发一次恢复', async () => {
  const world = makeIntegrationWorld()
  world.integration[MIVO_INT].runs[MIVO_INT_SHA] = { status: 'completed', conclusion: 'failure' }
  world.mainRuns[MIVO_MAIN] = { status: 'in_progress', conclusion: null }
  const env = await envWith(world)

  const first = (await tick(env)).events
  assert.equal(ofType(first, 'lane_paused').length, 1, 'main 在跑，车道暂停')
  assert.deepEqual(ofType(first, 'integration_ci_red'), [{
    type: 'integration_ci_red', repo: MIVO, branch: MIVO_INT, head: MIVO_INT_SHA, reason: `${MIVO_INT} 99999999 CI=failure（在用的 PR：#1）`,
  }])
  assert.deepEqual(ofType((await tick(env)).events, 'integration_ci_red'), [], '同一提交不再发')

  world.integration[MIVO_INT].runs[MIVO_INT_SHA] = { status: 'completed', conclusion: 'success' }
  const recovered = (await tick(env)).events
  assert.deepEqual(ofType(recovered, 'integration_ci_recovered'), [{ type: 'integration_ci_recovered', repo: MIVO, branch: MIVO_INT, head: MIVO_INT_SHA, reason: `${MIVO_INT} 99999999` }])
  assert.deepEqual(ofType((await tick(env)).events, 'integration_ci_recovered'), [], '恢复只报一次')
  assert.deepEqual(env.fake.writes(), [])
})

test('#48 SC3 集成分支 ci.yml 成功但 push 触发的检查失败：发 integration_ci_red，原因列出失败项', async () => {
  const world = makeIntegrationWorld()
  world.branchChecks[MIVO_INT_SHA] = [...greenBranchChecks(), run(930, 'Windows plugin smoke', 'completed', 'failure')]
  const env = await envWith(world)
  assert.deepEqual(ofType((await tick(env)).events, 'integration_ci_red').map((e) => e.reason), [`${MIVO_INT} 99999999 Windows plugin smoke=failure（在用的 PR：#1）`])
})

test('#48 SC3 集成分支还在跑：不发红灯', async () => {
  const world = makeIntegrationWorld()
  world.integration[MIVO_INT].runs[MIVO_INT_SHA] = { status: 'in_progress', conclusion: null }
  const env = await envWith(world)
  assert.deepEqual(ofType((await tick(env)).events, 'integration_ci_red'), [])
})

// SC4

test('#48 SC4 没有开放 PR 在用的集成分支红了不看也不发', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  world.integration[MIVO_INT].runs[MIVO_INT_SHA] = { status: 'completed', conclusion: 'failure' }
  const env = await envWith(world)
  assert.deepEqual(ofType((await tick(env)).events, 'integration_ci_red'), [])
  assert.deepEqual(branchReads(env, MIVO_INT), [], '没有 PR 在用，不读这个分支')
})

test('#48 SC4 两个集成分支同一轮都红：各发一条，叫醒伙伴的消息里各有一行', async () => {
  const world = makeIntegrationWorld()
  world.integration[MIVO_INT].runs[MIVO_INT_SHA] = { status: 'completed', conclusion: 'failure' }
  world.integration[INT_Y] = { sha: INT_Y_SHA, runs: { [INT_Y_SHA]: { status: 'completed', conclusion: 'failure' } } }
  world.prs[2].rest.base = { ref: INT_Y }
  const env = await makeMivoEnv({ world })
  // 队列是空的：线上常态是车道状态里已有 main 的记录，每轮照常跑 beforeItems
  env.store.saveLanes({ [MIVO]: { checkedMainSha: MIVO_MAIN } })
  const events = (await tick(env)).events
  const lines = toEventLines(events).map((line) => JSON.parse(line)).filter((ev) => ev.type === 'integration_ci_red')
  assert.deepEqual(lines.map((ev) => ev.branch), [MIVO_INT, INT_Y])
})

// SC5

test('#48 SC5 列开放 PR 失败：本轮照常处理队列，不发红灯，只记 ci_watch_failed（不叫醒伙伴）', async () => {
  const world = makeIntegrationWorld({ listStatus: 503 })
  world.integration[MIVO_INT].runs[MIVO_INT_SHA] = { status: 'completed', conclusion: 'failure' }
  const env = await envWith(world)
  const events = (await tick(env)).events
  assert.deepEqual(ofType(events, 'integration_ci_red'), [])
  assert.equal(ofType(events, 'ci_watch_failed').length, 1)
  assert.ok(lastChecked(env, 2), '队列里的 #2 本轮照常处理')
  assert.ok(!toEventLines(events).some((line) => JSON.parse(line).type === 'ci_watch_failed'))
})

test('#48 SC5 读某个集成分支失败：不打断本轮，只记 ci_watch_failed', async () => {
  const world = makeIntegrationWorld()
  world.prs[1].rest.base = { ref: 'integration/gone' }
  const env = await envWith(world)
  const events = (await tick(env)).events
  assert.deepEqual(ofType(events, 'ci_watch_failed').map((e) => e.branch), ['integration/gone'])
  assert.ok(lastChecked(env, 2), '队列里的 #2 本轮照常处理')
})

test('#48 SC5 已判绿的集成分支：之后每轮只多读 1 次分支头，不再读 CI 和检查', async () => {
  const world = makeIntegrationWorld()
  const env = await envWith(world)
  await tick(env)
  assert.equal(ciRunReads(env, MIVO_INT).length, 1, '第一轮读了 CI，判绿')
  const before = { branch: branchReads(env, MIVO_INT).length, ci: ciRunReads(env, MIVO_INT).length, checks: checkReads(env, MIVO_INT_SHA).length }
  await tick(env) // 车道状态里已有 main 的记录，下一轮照常跑 beforeItems
  assert.equal(branchReads(env, MIVO_INT).length - before.branch, 1)
  assert.equal(ciRunReads(env, MIVO_INT).length - before.ci, 0)
  assert.equal(checkReads(env, MIVO_INT_SHA).length - before.checks, 0)
})

test('#48 SC5 开了自动接单且列表不按 base 过滤时，红灯监视复用同一次列表请求', async () => {
  const world = makeIntegrationWorld()
  world.integration[MIVO_INT].runs[MIVO_INT_SHA] = { status: 'completed', conclusion: 'failure' }
  const autoIntake = { authors: ['praise-qa[bot]'], label: 'review:merge-ready', base: ['main', 'integration/*'], label_actors: ['praisebuild[bot]'] }
  const env = await envWith(world, { autoIntake })
  const events = (await tick(env)).events
  assert.equal(ofType(events, 'integration_ci_red').length, 1)
  assert.equal(env.fake.calls.filter((c) => c.method === 'GET' && c.path === `/repos/${MIVO}/pulls`).length, 1)
  assert.ok(ciRunReads(env, MIVO_INT).length >= 1 && checkReads(env, MIVO_INT_SHA).length === 0, 'ci.yml 失败就不再读检查')
})

// SC7

test('#48 SC7 运维手册、总览、README 写明新事件、判定口径和飞书发法', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const ops = read('docs/operations.md')
  const section = ops.slice(ops.indexOf('### CI 变红飞书通知'))
  for (const phrase of ['`main_ci_red` / `integration_ci_red`', '`integration_ci_recovered`', '`cindy_feishu_bot` 的 `send_message_to_user`', '`server` 填 `cindy_feishu_bot`',
    '`NO_CHAT_CONTEXT`', '还在跑、读不到、来源未知都不算红', '同一分支同一提交只发一次', '`ci_watch_failed`', '没有开放 PR 在用的集成分支不看']) {
    assert.ok(section.includes(phrase) || ops.includes(phrase), phrase)
  }
  assert.ok(read('docs/how-it-works.md').includes('**CI 变红发飞书**'))
  const readme = read('README.md')
  for (const phrase of ['**CI 变红飞书通知**', '`main_ci_red` / `integration_ci_red`', '集成分支原来开着 strict，2026-11-12 用户定关掉']) assert.ok(readme.includes(phrase), phrase)
})

// SC6

test('#48 SC6 有 CI 红灯事件时，给伙伴的消息里写明用飞书机器人 send_message_to_user 通知用户；没有时消息不变', () => {
  const plain = [JSON.stringify({ type: 'lane_paused', repo: MIVO, pr: null, reason: 'x' })]
  assert.equal(toPartnerMessage(plain, { shadow: false }), [
    'praise-merge 事件（1 条）', '```jsonl', ...plain, '```', '按 praise-merge 仓 docs/operations.md「伙伴怎么处理事件」通知用户。',
  ].join('\n'))
  for (const type of ['main_ci_red', 'integration_ci_red']) {
    const message = toPartnerMessage([...plain, JSON.stringify({ type, repo: MIVO, pr: null, branch: 'main' })], { shadow: false })
    assert.ok(message.endsWith(`\n${FEISHU_LINE}`), type)
    assert.match(FEISHU_LINE, /cindy_feishu_bot 的 send_message_to_user/)
  }
  const recovered = toPartnerMessage([JSON.stringify({ type: 'integration_ci_recovered', repo: MIVO, pr: null, branch: MIVO_INT })], { shadow: false })
  assert.ok(!recovered.includes(FEISHU_LINE), '恢复不发飞书')
})
