// #53：红灯事件带上该通知谁。cause 是弄红它的 PR（从红的分支头沿第一父提交往回找到最早变红的提交），owners 是集成分支负责人。
// 飞书发给谁、怎么转给用户见 tests/red-notice.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { toEventLines } from '../src/events.mjs'
import { MAX_CAUSE_STEPS, selectCausePull, toBranchOwners } from '../src/ci-watch.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, seedMivoItem, greenBranchChecks, pushWorkflowRun, MIVO, MIVO_MAIN, MIVO_INT, MIVO_INT_SHA } from './helpers/fake-mivo.mjs'

const tick = (env) => runTick({ ...env, now: Date.now() })
const ofType = (events, type) => events.filter((e) => e.type === type)
const FAILED = { status: 'completed', conclusion: 'failure' }
const PASSED = { status: 'completed', conclusion: 'success' }
const sha = (char) => char.repeat(40)
// 把这个提交合进 base 的 PR（合并提交就是它）
const mergedPull = (number, login, mergeSha, base = 'main') => ({ number, user: { login }, base: { ref: base }, merged_at: '2026-11-20T13:31:00Z', merge_commit_sha: mergeSha })
const commit = (parent, login = null) => ({ parents: parent ? [{ sha: parent }] : [], author: login ? { login } : null })

async function envWith(world) {
  const env = await makeMivoEnv({ world })
  seedMivoItem(env.store, 2)
  return env
}

// main 上一个绿的提交：ci.yml 成功，push 触发的检查都绿
function addGreenMainCommit(world, commitSha) {
  world.mainRuns[commitSha] = PASSED
  world.branchChecks[commitSha] = greenBranchChecks()
  world.workflowRuns[commitSha] = [pushWorkflowRun()]
}

// SC1

test('#53 SC1 main 红、父提交是绿的：cause 是把红提交合进来的 PR 和它的作者，找准了', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const green = sha('b')
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(green, 'merger')
  world.commitPulls[MIVO_MAIN] = [mergedPull(77, 'alice', MIVO_MAIN)]
  addGreenMainCommit(world, green)
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'main_ci_red')
  assert.equal(red.length, 1)
  assert.deepEqual(red[0].cause, { sha: MIVO_MAIN, pr: 77, author: 'alice', certain: true })
  assert.equal(red[0].owners, undefined, 'main 没有分支负责人')
  assert.deepEqual(env.fake.writes(), [])
})

test('#53 SC1 叫醒伙伴的事件行带 cause 和 owners；别的事件行不带', async () => {
  const lines = toEventLines([
    { type: 'integration_ci_red', repo: MIVO, branch: MIVO_INT, head: MIVO_INT_SHA, reason: 'r', cause: { sha: MIVO_INT_SHA, pr: 7, author: 'alice', certain: true }, owners: ['bob'] },
    { type: 'main_ci_red', repo: MIVO, branch: 'main', head: MIVO_MAIN, reason: 'r', cause: null },
    { type: 'merged', repo: MIVO, pr: 3, head: 'h' },
  ]).map((line) => JSON.parse(line))
  assert.deepEqual(lines[0].cause, { sha: MIVO_INT_SHA, pr: 7, author: 'alice', certain: true })
  assert.deepEqual(lines[0].owners, ['bob'])
  assert.equal(lines[1].cause, null, '查不到时写明 null')
  assert.ok(!('cause' in lines[2]) && !('owners' in lines[2]))
})

// SC2

test('#53 SC2 连续红：分支头 B 红、父提交 A 也红、A 的父提交是绿的，cause 是 A 的 PR，不是 B 的', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const [b, a, green] = [MIVO_MAIN, sha('b'), sha('c')]
  world.mainRuns[b] = FAILED
  world.mainRuns[a] = FAILED
  world.commits[b] = commit(a)
  world.commits[a] = commit(green)
  world.commitPulls[b] = [mergedPull(2612, 'late-author', b)]
  world.commitPulls[a] = [mergedPull(2599, 'aj0928', a)]
  addGreenMainCommit(world, green)
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'main_ci_red')
  assert.deepEqual(red.map((e) => e.cause), [{ sha: a, pr: 2599, author: 'aj0928', certain: true }])
  assert.equal(red[0].head, b, '事件本身仍是当前分支头')
})

test('#53 SC2 父提交的 CI 被取消、还在跑、或没有运行记录：停在当前提交，certain 为 false', async () => {
  for (const [name, parentRun] of [['cancelled', { status: 'completed', conclusion: 'cancelled' }], ['in_progress', { status: 'in_progress', conclusion: null }], ['no_run', null]]) {
    const world = makeMivoWorld({ mergeQueue: null })
    const parent = sha('b')
    world.mainRuns[MIVO_MAIN] = FAILED
    if (parentRun) world.mainRuns[parent] = parentRun
    world.commits[MIVO_MAIN] = commit(parent)
    world.commits[parent] = commit(sha('c'))
    world.commitPulls[MIVO_MAIN] = [mergedPull(11, 'bob', MIVO_MAIN)]
    world.commitPulls[parent] = [mergedPull(10, 'alice', parent)]
    const env = await envWith(world)
    const red = ofType((await tick(env)).events, 'main_ci_red')
    assert.deepEqual(red.map((e) => e.cause), [{ sha: MIVO_MAIN, pr: 11, author: 'bob', certain: false }], name)
  }
})

test(`#53 SC2 一路都红：最多往回走 ${MAX_CAUSE_STEPS} 步，停在第 ${MAX_CAUSE_STEPS} 个父提交，certain 为 false`, async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  // chain[0] 是分支头，往后每个是前一个的父提交；都红
  const chain = [MIVO_MAIN, ...Array.from({ length: MAX_CAUSE_STEPS + 3 }, (_, i) => String(i + 1).padStart(40, '0'))]
  chain.forEach((commitSha, i) => {
    world.mainRuns[commitSha] = FAILED
    world.commits[commitSha] = commit(chain[i + 1] ?? null)
    world.commitPulls[commitSha] = [mergedPull(100 + i, `author-${i}`, commitSha)]
  })
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'main_ci_red')
  assert.deepEqual(red.map((e) => e.cause), [{ sha: chain[MAX_CAUSE_STEPS], pr: 100 + MAX_CAUSE_STEPS, author: `author-${MAX_CAUSE_STEPS}`, certain: false }])
})

// SC3

test('#53 SC3 集成分支红：owners 取目标分支是它的开放 PR 的作者（按 PR 号、去重），cause 按这个分支上的 CI 往回找', async () => {
  const world = makeIntegrationWorld()
  const [parent, green] = [sha('b'), sha('c')]
  world.integration[MIVO_INT].runs = { [MIVO_INT_SHA]: FAILED, [parent]: FAILED, [green]: PASSED }
  world.branchChecks[green] = greenBranchChecks()
  world.workflowRuns[green] = [pushWorkflowRun()]
  world.commits[MIVO_INT_SHA] = commit(parent)
  world.commits[parent] = commit(green)
  world.commitPulls[parent] = [mergedPull(2599, 'aj0928', parent, MIVO_INT)]
  world.prs[3] = { rest: { number: 3, state: 'open', merged: false, draft: false, user: { login: 'carol' }, base: { ref: MIVO_INT }, head: { sha: sha('e') }, labels: [] } }
  world.prs[4] = { rest: { number: 4, state: 'open', merged: false, draft: false, user: { login: 'praisezhu' }, base: { ref: MIVO_INT }, head: { sha: sha('f') }, labels: [] } }
  const env = await envWith(world)
  const red = ofType((await tick(env)).events, 'integration_ci_red')
  assert.equal(red.length, 1)
  assert.deepEqual(red[0].owners, ['PraiseZhu', 'carol'], '#1 PraiseZhu、#3 carol；#4 praisezhu 只是大小写不同')
  assert.deepEqual(red[0].cause, { sha: parent, pr: 2599, author: 'aj0928', certain: true })
})

test('#53 SC3 有同仓、源分支是它的开放 PR（合回 main 的阶段 PR）时，负责人只取这种 PR 的作者', () => {
  const targeting = { number: 1, user: { login: 'contributor' }, base: { ref: MIVO_INT }, head: { ref: 'feat/x', repo: { full_name: MIVO } } }
  const stage = { number: 9, user: { login: 'stage-owner' }, base: { ref: 'main' }, head: { ref: MIVO_INT, repo: { full_name: MIVO } } }
  const forkStage = { number: 8, user: { login: 'outsider' }, base: { ref: 'main' }, head: { ref: MIVO_INT, repo: { full_name: 'Someone/fork' } } }
  const other = { number: 2, user: { login: 'elsewhere' }, base: { ref: 'integration/other' }, head: { ref: 'feat/y', repo: { full_name: MIVO } } }
  assert.deepEqual(toBranchOwners([targeting, stage, forkStage, other], MIVO, MIVO_INT), ['stage-owner'])
  assert.deepEqual(toBranchOwners([targeting, forkStage, other], MIVO, MIVO_INT), ['contributor'], 'fork 里同名的源分支不算阶段 PR')
  assert.deepEqual(toBranchOwners([other], MIVO, MIVO_INT), [])
})

// SC5

test('#53 SC5 红提交没有对应的 PR（直接推送）：pr 为 null，author 取提交的 GitHub 作者账号；只是包含这个提交的开放 PR 不算', async () => {
  const world = makeMivoWorld({ mergeQueue: null })
  const green = sha('b')
  world.mainRuns[MIVO_MAIN] = FAILED
  world.commits[MIVO_MAIN] = commit(green, 'dave')
  // 集成分支合回 main 的阶段 PR 也会出现在「提交关联的 PR」里：没合并，合并提交也不是它
  world.commitPulls[MIVO_MAIN] = [{ number: 5, user: { login: 'stage-owner' }, base: { ref: 'main' }, merged_at: null, merge_commit_sha: sha('d') }]
  addGreenMainCommit(world, green)
  const env = await envWith(world)
  assert.deepEqual(ofType((await tick(env)).events, 'main_ci_red').map((e) => e.cause), [{ sha: MIVO_MAIN, pr: null, author: 'dave', certain: true }])
})

test('#53 SC5 提交关联的 PR 怎么选：合并提交就是它的优先；其次已合并且目标分支对得上的；都没有返回 null', () => {
  const byMergeSha = mergedPull(1, 'a', MIVO_MAIN, 'integration/other')
  const byBase = { ...mergedPull(2, 'b', sha('d')), base: { ref: 'main' } }
  const openOnly = { number: 3, user: { login: 'c' }, base: { ref: 'main' }, merged_at: null, merge_commit_sha: null }
  assert.equal(selectCausePull([openOnly, byBase, byMergeSha], { sha: MIVO_MAIN, branch: 'main' }).number, 1)
  assert.equal(selectCausePull([openOnly, byBase], { sha: MIVO_MAIN, branch: 'main' }).number, 2)
  assert.equal(selectCausePull([openOnly], { sha: MIVO_MAIN, branch: 'main' }), null)
  assert.equal(selectCausePull(null, { sha: MIVO_MAIN, branch: 'main' }), null)
})

test('#53 SC5 找弄红它的 PR 时读 GitHub 失败：红灯照发一次，cause 为 null，另记 ci_watch_failed（不叫醒伙伴）', async () => {
  for (const [name, makeWorld, type, branch] of [
    ['main', () => makeMivoWorld({ mergeQueue: null, commitPullsFail: 502 }), 'main_ci_red', 'main'],
    ['integration', () => makeIntegrationWorld({ commitPullsFail: 502 }), 'integration_ci_red', MIVO_INT],
  ]) {
    const world = makeWorld()
    if (branch === 'main') world.mainRuns[MIVO_MAIN] = FAILED
    else world.integration[MIVO_INT].runs[MIVO_INT_SHA] = FAILED
    const env = await envWith(world)
    const first = (await tick(env)).events
    const red = ofType(first, type)
    assert.equal(red.length, 1, name)
    assert.equal(red[0].cause, null, name)
    const failed = ofType(first, 'ci_watch_failed')
    assert.deepEqual(failed.map((e) => e.branch), [branch], name)
    assert.match(failed[0].reason, /查弄红它的 PR 失败（.*502/, name)
    assert.ok(!toEventLines(first).some((line) => JSON.parse(line).type === 'ci_watch_failed'), name)
    assert.deepEqual(ofType((await tick(env)).events, type), [], `${name}：同一提交不再发`)
  }
})
