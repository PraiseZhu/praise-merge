// Mivo 车道：门禁全过后，main 开着合并队列就用 App 入队（组合测试和合并由队列完成）；
// 没开队列就由 App 直接合并（squash，锁定检查过的 head）。
// Mivo 没开 strict，单 PR 绿灯不代表和新 main 组合后也能过（Mivo #1551），所以直接合并前 PR 必须不落后 main：
// 落后就先 update-branch，等新 head 上的必需检查重新通过再合。
// GitHub 的合并接口锁不住 base：检查到合并之间 main 若被别人推进，合入的组合就没测过。
// 这个窗口关不死（对 App 单开 strict 会让别人被拦下的 PR 显示 BEHIND，审查机当成状态变化反复重审，2026-11-06 试过已撤）。
// 所以本轮钉住 CI 已成功的那个 main 提交，落后判断对着它比；合并后核对父提交是不是它，不是就冻结车道。
// 依赖顺序由 tick 保证（依赖没 merged 就不会走到这里），所以有依赖的 PR 要等前一个真正合进 main 才处理。
import { AUTHOR } from '../policy.mjs'
import { toRequiredChecksVerdict } from '../mivo-required.mjs'
import { GitHubError } from '../github.mjs'

const PR_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$branch:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){id mergeStateStatus mergeQueueEntry{state}} mergeQueue(branch:$branch){id}}}'
const ENQUEUE = 'mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{id state}}}'
const BASE = 'main'

export default {
  id: 'mivo',

  // 每轮先看车道级条件：规则集没被改松（改松就冻结）；main 当前 head 的 CI 成功（不满足只暂停，不冻结）。
  // 只认 main 当前 head 的 run：刚合进去的提交 CI 还没出结论时，旧提交的 success 不算数。
  async beforeItems({ repo, laneState, client, repoPolicy }) {
    const required = await toRequiredChecksVerdict({ client, repo, repoPolicy, branch: BASE })
    if (!required.ok) {
      laneState.frozen = { reason: required.reason, at: new Date().toISOString() }
      return { stopLane: true, events: [{ type: 'lane_frozen', repo, reason: required.reason }] }
    }
    const pause = (reason) => {
      const events = laneState.paused === reason ? [] : [{ type: 'lane_paused', repo, reason }]
      laneState.paused = reason
      return { stopLane: true, events }
    }
    const mainSha = (await client.request('GET', `/repos/${repo}/branches/${BASE}`)).commit.sha
    const runs = await client.request('GET', `/repos/${repo}/actions/workflows/ci.yml/runs?branch=${BASE}&event=push&head_sha=${mainSha}&per_page=1`)
    const latest = runs.workflow_runs?.[0]
    if (!latest || latest.conclusion !== 'success') return pause(`main_ci_not_success: ${mainSha.slice(0, 8)} ${latest ? `${latest.status}/${latest.conclusion}` : 'no_run'}`)
    const events = laneState.paused ? [{ type: 'lane_resumed', repo }] : []
    delete laneState.paused
    laneState.checkedMainSha = mainSha
    return { events }
  },

  async process({ item, repoPolicy, laneState, client, facts, shadow }) {
    const pr = await facts.pr()
    if (pr.merged) return { status: 'merged', reason: item.queueState === 'enqueued' ? 'merged_by_queue' : 'merged_elsewhere', events: [{ type: 'merged', repo: item.repo, pr: item.number, head: pr.head.sha }] }
    if (pr.state !== 'open') return { status: 'closed', reason: `pr_${pr.state}` }
    const head = pr.head.sha
    if (!item.seenHeads.includes(head)) item.seenHeads.push(head)

    const [owner, name] = item.repo.split('/')
    const { pullRequest: gql, mergeQueue } = (await client.graphql(PR_QUERY, { owner, name, number: item.number, branch: BASE })).repository

    if (item.queueState === 'enqueued') {
      if (gql.mergeQueueEntry) return { reason: `in_merge_queue: ${gql.mergeQueueEntry.state}` }
      return { status: 'dequeued', reason: '被移出合并队列且未合入（组合 CI 失败或被人移出），不自动重新入队', events: [{ type: 'dequeued', repo: item.repo, pr: item.number, head }] }
    }

    const failures = await toMivoFailures({ pr, gql, repoPolicy, facts })
    if (failures.length) return { reason: failures.join(' | ') }

    if (mergeQueue) return toEnqueue({ item, gql, head, client, shadow })

    // 用 beforeItems 里 CI 已确认成功的那个 main 提交，不再另读（另读可能是 CI 还没出结论的新提交）
    const mainSha = laneState.checkedMainSha
    if (!mainSha) return { stopLane: true, reason: 'main_not_checked: 本轮没有确认 main 的 CI，跳过' }
    const behind = await facts.behindBy(mainSha, head)
    if (behind > 0) return toUpdateBranch({ item, head, behind, client, shadow })
    // 若 main 将来开了 strict：BEHIND 但对钉住的提交不落后，说明 main 在本轮检查后又前进了，下一轮重判
    if (gql.mergeStateStatus === 'BEHIND') return { stopLane: true, reason: `merge_state: BEHIND（main 已越过本轮检查的 ${mainSha.slice(0, 8)}），下一轮重判` }
    return toDirectMerge({ item, head, mainSha, repoPolicy, laneState, client, shadow })
  },
}

// helpers

async function toEnqueue({ item, gql, head, client, shadow }) {
  if (shadow) {
    const events = item.shadowLoggedHead === head ? [] : [{ type: 'would_enqueue', repo: item.repo, pr: item.number, head }]
    item.shadowLoggedHead = head
    return { reason: 'shadow_would_enqueue', events }
  }
  await client.graphql(ENQUEUE, { id: gql.id, oid: head })
  item.queueState = 'enqueued'
  return { reason: 'enqueued', events: [{ type: 'enqueued', repo: item.repo, pr: item.number, head }] }
}

// 追 main 会换 head：CI 和审查机都要在新 head 上重跑，下一轮门禁按新 head 重新判断
async function toUpdateBranch({ item, head, behind, client, shadow }) {
  const reason = `up_to_date: 落后 main ${behind} 个提交`
  if (shadow) {
    const events = item.shadowLoggedHead === `update:${head}` ? [] : [{ type: 'would_update_branch', repo: item.repo, pr: item.number, head }]
    item.shadowLoggedHead = `update:${head}`
    return { stopLane: true, reason: `shadow_would_update_branch | ${reason}`, events }
  }
  await client.request('PUT', `/repos/${item.repo}/pulls/${item.number}/update-branch`, { expected_head_sha: head })
  return { stopLane: true, reason: `update_branch_requested | ${reason}`, events: [{ type: 'update_branch', repo: item.repo, pr: item.number, head }] }
}

async function toDirectMerge({ item, head, mainSha, repoPolicy, laneState, client, shadow }) {
  if (shadow) {
    const events = item.shadowLoggedHead === head ? [] : [{ type: 'would_merge', repo: item.repo, pr: item.number, head }]
    item.shadowLoggedHead = head
    return { stopLane: true, reason: 'shadow_would_merge', events }
  }
  let res
  try {
    res = await client.request('PUT', `/repos/${item.repo}/pulls/${item.number}/merge`, { sha: head, merge_method: repoPolicy.mergeMethod })
  } catch (err) {
    if (err instanceof GitHubError && [405, 409, 422].includes(err.status)) {
      return { stopLane: true, reason: `merge_refused: ${err.message}`, events: [{ type: 'merge_refused', repo: item.repo, pr: item.number, reason: err.message }] }
    }
    // 网络错误或 5xx：GitHub 那边可能已经合了。下一轮会把它当成别人合的、跳过核对，所以这里直接冻结等人看
    const reason = `merge_result_unknown: #${item.number} 合并请求没拿到明确结果（${err.message}），可能已合入；看过 PR 和 main CI 再 unfreeze`
    laneState.frozen = { reason, at: new Date().toISOString() }
    return { stopLane: true, reason, events: [{ type: 'lane_frozen', repo: item.repo, reason }] }
  }
  const events = [{ type: 'merged', repo: item.repo, pr: item.number, head, mergeSha: res.sha }]
  const freeze = (reason) => {
    laneState.frozen = { reason, at: new Date().toISOString() }
    events.push({ type: 'lane_frozen', repo: item.repo, reason })
  }
  // 已经合进去了：核对失败也不能抛错（抛了这条就记不成 merged，下一轮会当成别人合的，核对就丢了）
  let parents
  try {
    parents = (await client.request('GET', `/repos/${item.repo}/commits/${res.sha}`)).parents ?? []
  } catch (err) {
    freeze(`merge_parent_unverified: #${item.number} 已合入 ${res.sha.slice(0, 8)}，但读不到合并提交（${err.message}），无法确认组合测过；看过 main CI 再 unfreeze`)
    return { status: 'merged', reason: `merged ${res.sha}`, stopLane: true, events }
  }
  if (parents.length !== 1 || parents[0].sha !== mainSha) {
    const actual = parents.map((p) => p.sha.slice(0, 8)).join(',') || 'none'
    freeze(`merged_on_moved_main: #${item.number} 合并时 main 已不是检查时的 ${mainSha.slice(0, 8)}（合并提交的父提交 ${actual}），这个组合没测过；main CI 通过后再 unfreeze`)
  }
  return { status: 'merged', reason: `merged ${res.sha}`, stopLane: true, events }
}

async function toMivoFailures({ pr, gql, repoPolicy, facts }) {
  const failures = []
  if (pr.user?.login !== AUTHOR) failures.push(`author: 期望 ${AUTHOR}，实际 ${pr.user?.login}`)
  if (pr.draft) failures.push('not_draft: draft')
  if (pr.base.ref !== BASE) failures.push(`base: 期望 ${BASE}，实际 ${pr.base.ref}`)
  const states = await facts.checkStates(pr.head.sha)
  const bad = repoPolicy.requiredChecks.flatMap((context) => {
    const s = states.get(context)
    if (!s?.passed) return [`${context}=${s?.state ?? 'missing'}`]
    if (repoPolicy.integrationId !== null && (s.kind !== 'check' || s.appId !== repoPolicy.integrationId)) return [`${context}: 写入方不是 integration ${repoPolicy.integrationId}`]
    return []
  })
  if (bad.length) failures.push(`required_checks: ${bad.join(', ')}`)
  const open = await facts.unresolvedThreads()
  if (open > 0) failures.push(`threads_resolved: 未解决讨论 ${open} 条`)
  // mergeStateStatus 按调用者计算，这里是 App 自己看到的值
  // BEHIND 留给后面的落后判断处理（main 开了 strict 时，落后的 PR 是 BEHIND 而不是 CLEAN）
  if (!['CLEAN', 'BEHIND'].includes(gql.mergeStateStatus)) failures.push(`merge_state: ${gql.mergeStateStatus}`)
  return failures
}
