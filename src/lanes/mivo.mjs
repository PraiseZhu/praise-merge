// Mivo 车道：门禁全过后，main 开着合并队列就用 App 入队（组合测试和合并由队列完成）；
// 没开队列就由 App 直接合并（squash，锁定检查过的 head）。
// Mivo 没开 strict，单 PR 绿灯不代表和新 main 组合后也能过（Mivo #1551），所以直接合并前 PR 必须不落后 main：
// 落后就先 update-branch，等新 head 上的必需检查重新通过再合。
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
    return { events }
  },

  async process({ item, repoPolicy, client, facts, shadow }) {
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

    const behind = await facts.behindBy(BASE, head)
    if (behind > 0) return toUpdateBranch({ item, head, behind, client, shadow })
    return toDirectMerge({ item, head, repoPolicy, client, shadow })
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

async function toDirectMerge({ item, head, repoPolicy, client, shadow }) {
  if (shadow) {
    const events = item.shadowLoggedHead === head ? [] : [{ type: 'would_merge', repo: item.repo, pr: item.number, head }]
    item.shadowLoggedHead = head
    return { stopLane: true, reason: 'shadow_would_merge', events }
  }
  try {
    const res = await client.request('PUT', `/repos/${item.repo}/pulls/${item.number}/merge`, { sha: head, merge_method: repoPolicy.mergeMethod })
    return { status: 'merged', reason: `merged ${res.sha}`, stopLane: true, events: [{ type: 'merged', repo: item.repo, pr: item.number, head, mergeSha: res.sha }] }
  } catch (err) {
    if (!(err instanceof GitHubError) || ![405, 409, 422].includes(err.status)) throw err
    return { stopLane: true, reason: `merge_refused: ${err.message}`, events: [{ type: 'merge_refused', repo: item.repo, pr: item.number, reason: err.message }] }
  }
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
  if (gql.mergeStateStatus !== 'CLEAN') failures.push(`merge_state: ${gql.mergeStateStatus}`)
  return failures
}
