// #36：全绿判断只看这个提交被 push 时跑出来的检查；别的 PR 的审查、定时任务、评论触发的工作流写到 main 头提交上的检查不算
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTick } from '../src/tick.mjs'
import { makeMivoEnv, makeMivoWorld, makeIntegrationWorld, seedMivoItem, pushWorkflowRun, ACTIONS_APP, MIVO, MIVO_MAIN, MIVO_INT, MIVO_INT_SHA } from './helpers/fake-mivo.mjs'

const tick = (env) => runTick({ ...env, now: Date.now() })
const item = (env, n = 1) => env.store.loadQueue().items.find((it) => it.number === n)
const lane = (env) => env.store.loadLanes()[MIVO]
const directMerges = (env) => env.fake.calls.filter((c) => /\/pulls\/\d+\/merge$/.test(c.path))
const noQueue = () => makeMivoWorld({ mergeQueue: null })

// 和 Mivo main 08b54b5f 上的真实来源一致（2026-11-08 核实）：每个 workflow run 一个 check suite
let nextSuite = 7100
function addSource(world, sha, { event, name }, checks) {
  const suite = nextSuite++
  world.workflowRuns[sha] = [...(world.workflowRuns[sha] ?? []), { id: 9000 + suite, check_suite_id: suite, event, name }]
  world.branchChecks[sha] = [...world.branchChecks[sha], ...checks.map(([id, checkName, status, conclusion = null]) => ({ id, name: checkName, status, conclusion, app: ACTIONS_APP, check_suite: { id: suite } }))]
  return suite
}
const REVIEW = { event: 'workflow_dispatch', name: 'review-pr #2007 7e229618' }
const CODEQL_SCHEDULED = { event: 'dynamic', name: 'Code Quality: Scheduled' }
const CODE_SCANNING_SCHEDULED = { event: 'dynamic', name: 'Scheduled' }
const CODEQL_PUSH = { event: 'dynamic', name: 'Code Quality: Push on main' }
const CODE_SCANNING_PUSH = { event: 'dynamic', name: 'Push on main' }

async function run(world, seed = (env) => seedMivoItem(env.store)) {
  const env = await makeMivoEnv({ world })
  seed(env)
  const { events } = await tick(env)
  return { env, events }
}
function assertMerged({ env, events }) {
  assert.equal(lane(env)?.paused, undefined, lane(env)?.paused)
  assert.ok(!events.some((e) => e.type === 'lane_paused'))
  assert.equal(directMerges(env).length, 1)
  assert.equal(item(env).status, 'merged')
}
function assertPaused({ env, events }, reason) {
  assert.deepEqual(env.fake.writes(), [])
  assert.equal(item(env).status, 'queued')
  assert.match(lane(env).paused, reason)
  assert.ok(events.some((e) => e.type === 'lane_paused'))
}

// SC1

test('#36 SC1 main 提交上只有非 push 触发的检查在跑或失败（审查机审别的 PR、定时 CodeQL、PR gate rerun 等），push 的全绿：不暂停，照常合并', async () => {
  const world = noQueue()
  addSource(world, MIVO_MAIN, REVIEW, [[1001, 'review-pr', 'in_progress']])
  addSource(world, MIVO_MAIN, CODEQL_SCHEDULED, [[1002, 'Analyze (python)', 'completed', 'failure']])
  addSource(world, MIVO_MAIN, { event: 'workflow_run', name: 'PR gate rerun' }, [[1003, 'rerun-failed-gates', 'completed', 'failure']])
  addSource(world, MIVO_MAIN, { event: 'issue_comment', name: 'Windows Control Approval Refresh' }, [[1004, 'refresh', 'queued']])
  addSource(world, MIVO_MAIN, { event: 'issues', name: 'Merge Thanks' }, [[1005, '合并致谢', 'completed', 'cancelled']])
  addSource(world, MIVO_MAIN, { event: 'schedule', name: 'Slack Issue Inbound' }, [[1006, 'Slack 回复同步', 'completed', 'failure']])
  assertMerged(await run(world))
})

for (const [source, check] of [
  [REVIEW, [1001, 'review-pr', 'in_progress']],
  [{ event: 'schedule', name: 'Review Watchdog' }, [1001, '前置审查心跳', 'completed', 'failure']],
  [{ event: 'issue_comment', name: 'Windows Control Approval Refresh' }, [1001, 'refresh', 'in_progress']],
  [{ event: 'workflow_run', name: 'plugin-health' }, [1001, 'plugin health (red -> issue)', 'completed', 'failure']],
  [{ event: 'issues', name: 'Merge Thanks' }, [1001, '确认 issue 播报', 'queued']],
  [{ event: 'dynamic', name: 'npm_and_yarn in /. for minimatch - Update #1683965334' }, [1001, 'Dependabot', 'completed', 'failure']],
]) {
  test(`#36 SC1 只有 ${source.event}（${source.name}）的检查不绿：不算，照常合并`, async () => {
    const world = noQueue()
    addSource(world, MIVO_MAIN, source, [check])
    assertMerged(await run(world))
  })
}

// SC2

test('#36 SC2 push 触发的检查有一项失败：照旧暂停，原因只列 push 触发的检查，不列别的 PR 的审查和定时任务', async () => {
  const world = noQueue()
  addSource(world, MIVO_MAIN, REVIEW, [[1001, 'review-pr', 'in_progress']])
  addSource(world, MIVO_MAIN, CODEQL_SCHEDULED, [[1002, 'Analyze (javascript-typescript)', 'completed', 'failure']])
  world.branchChecks[MIVO_MAIN].push({ id: 1010, name: 'verify', status: 'completed', conclusion: 'failure', app: ACTIONS_APP, check_suite: { id: pushWorkflowRun().check_suite_id } })
  assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa verify=failure$/)
})

test('#36 SC2 push 触发的检查还在跑：暂停', async () => {
  const world = noQueue()
  world.branchChecks[MIVO_MAIN].push({ id: 1010, name: 'Windows unit shard (1/4)', status: 'in_progress', conclusion: null, app: ACTIONS_APP, check_suite: { id: pushWorkflowRun().check_suite_id } })
  assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa Windows unit shard \(1\/4\)=in_progress$/)
})

test('#36 SC2 别的 App（不是 GitHub Actions）写的检查照旧都算', async () => {
  const world = noQueue()
  world.branchChecks[MIVO_MAIN].push({ id: 1010, name: 'external-ci', status: 'completed', conclusion: 'failure', app: { id: 4242, slug: 'some-ci' }, check_suite: { id: 5555 } })
  assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa external-ci=failure$/)
})

// SC3

test('#36 SC3 读 workflow run 失败（502）：按不绿处理，暂停不合并', async () => {
  const world = noQueue()
  world.workflowRunsFail[MIVO_MAIN] = 502
  assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa 检查读取失败（GET \/repos\/xindong\/mivo-canvas-plugin\/actions\/runs\?head_sha=a{40}&exclude_pull_requests=true&per_page=100&page=1 -> 502 fake: workflow run 读失败）$/)
})

const manyRuns = (n) => Array.from({ length: n }, (_, i) => ({ id: 20000 + i, check_suite_id: 30000 + i, event: 'workflow_run', name: 'PR gate rerun' }))

test('#36 SC3 workflow run 分页读不完（GitHub 只给第 1 页）：按不绿处理，暂停不合并', async () => {
  const world = noQueue()
  world.workflowRuns[MIVO_MAIN] = [...manyRuns(149), pushWorkflowRun()]
  world.workflowRunPageLimit = 1
  assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa workflow run 读不全：共 150 个，只读到 100 个$/)
})

test('#36 SC3 workflow run 超过一页：读完全部分页，第 2 页上的 push run 也认得出来，照常合并', async () => {
  const world = noQueue()
  world.workflowRuns[MIVO_MAIN] = [...manyRuns(149), pushWorkflowRun()]
  assertMerged(await run(world))
})

test('#36 SC3 Actions 的检查找不到所属 workflow run（不知道是不是 push 触发的）：按不绿处理', async () => {
  const world = noQueue()
  world.branchChecks[MIVO_MAIN].push({ id: 1010, name: 'mystery', status: 'completed', conclusion: 'success', app: ACTIONS_APP, check_suite: { id: 6666 } })
  assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa mystery=来源未知（check suite 6666 没有对应的 workflow run）$/)
})

// SC4

for (const source of [CODEQL_PUSH, CODE_SCANNING_PUSH]) {
  test(`#36 SC4 CodeQL 默认配置 push 触发（${source.name}）的失败仍会暂停`, async () => {
    const world = noQueue()
    addSource(world, MIVO_MAIN, source, [[1001, 'Analyze (javascript-typescript)', 'completed', 'failure']])
    assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa Analyze \(javascript-typescript\)=failure$/)
  })
}

for (const source of [CODEQL_SCHEDULED, CODE_SCANNING_SCHEDULED]) {
  test(`#36 SC4 CodeQL 默认配置定时触发（${source.name}）的失败不算，照常合并`, async () => {
    const world = noQueue()
    addSource(world, MIVO_MAIN, source, [[1001, 'Analyze (javascript-typescript)', 'completed', 'failure']])
    assertMerged(await run(world))
  })
}

test('#36 SC4 同名 CodeQL：push 那次失败、之后定时重跑成功（id 更大）：仍按 push 那次算，暂停', async () => {
  const world = noQueue()
  addSource(world, MIVO_MAIN, CODEQL_PUSH, [[1001, 'Analyze (python)', 'completed', 'failure']])
  addSource(world, MIVO_MAIN, CODEQL_SCHEDULED, [[1002, 'Analyze (python)', 'completed', 'success']])
  assertPaused(await run(world), /^main_checks_not_green: aaaaaaaa Analyze \(python\)=failure$/)
})

test('#36 SC4 同名 CodeQL：push 那次成功、之后定时重跑失败（id 更大）：不算，照常合并', async () => {
  const world = noQueue()
  addSource(world, MIVO_MAIN, CODEQL_PUSH, [[1001, 'Analyze (python)', 'completed', 'success']])
  addSource(world, MIVO_MAIN, CODEQL_SCHEDULED, [[1002, 'Analyze (python)', 'completed', 'failure']])
  assertMerged(await run(world))
})

// SC5

const seedIntegration = (env) => seedMivoItem(env.store, 1, { base: MIVO_INT })

test('#36 SC5 集成分支同一规则：只有非 push 触发的检查不绿，照常合进集成分支', async () => {
  const world = makeIntegrationWorld()
  addSource(world, MIVO_INT_SHA, REVIEW, [[1001, 'review-pr (integration)', 'in_progress']])
  addSource(world, MIVO_INT_SHA, CODEQL_SCHEDULED, [[1002, 'Analyze (python)', 'completed', 'failure']])
  const { env } = await run(world, seedIntegration)
  assert.equal(item(env).status, 'merged')
  assert.deepEqual(directMerges(env).map((c) => c.body.merge_method), ['merge'])
})

test('#36 SC5 集成分支同一规则：push 触发的检查失败就不合，原因带分支名、只列 push 的检查', async () => {
  const world = makeIntegrationWorld()
  addSource(world, MIVO_INT_SHA, REVIEW, [[1001, 'review-pr (integration)', 'in_progress']])
  world.branchChecks[MIVO_INT_SHA].push({ id: 1010, name: 'verify', status: 'completed', conclusion: 'failure', app: ACTIONS_APP, check_suite: { id: pushWorkflowRun().check_suite_id } })
  const { env } = await run(world, seedIntegration)
  assert.deepEqual(env.fake.writes(), [])
  assert.equal(item(env).reason, `base_checks_not_green: ${MIVO_INT} 99999999 verify=failure`)
})

test('#36 SC5 集成分支同一规则：读 workflow run 失败就不合', async () => {
  const world = makeIntegrationWorld()
  world.workflowRunsFail[MIVO_INT_SHA] = 502
  const { env } = await run(world, seedIntegration)
  assert.deepEqual(env.fake.writes(), [])
  assert.match(item(env).reason, /^base_checks_not_green: integration\/x 99999999 检查读取失败（GET .*\/actions\/runs\?head_sha=9{40}.* -> 502/)
})
