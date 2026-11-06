// Mivo 车道：门禁全过就用 App 把 PR 放进 GitHub 合并队列，组合测试和合并由队列完成。
// 本车道没有任何直接合并的路径：队列没开时宁可等，也不改走 PUT …/merge。
// 依赖顺序由 tick 保证（依赖没 merged 就不会走到这里），所以有依赖的 PR 要等前一个真正合进 main 才入队。
import { AUTHOR } from '../policy.mjs'
import { toRequiredChecksVerdict } from '../mivo-required.mjs'

const PR_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id mergeStateStatus mergeQueueEntry{state}}}}'
const QUEUE_QUERY = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}'
const ENQUEUE = 'mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{id state}}}'
const BASE = 'main'

export default {
  id: 'mivo',

  // 每轮先看车道级条件：规则集没被改松（改松就冻结）、合并队列开着、main 最近一次 CI 成功（后两项不满足只暂停，不冻结）
  async beforeItems({ repo, laneState, client, repoPolicy }) {
    const required = await toRequiredChecksVerdict({ client, repo, repoPolicy, branch: BASE })
    if (!required.ok) {
      laneState.frozen = { reason: required.reason, at: new Date().toISOString() }
      return { stopLane: true, events: [{ type: 'lane_frozen', repo, reason: required.reason }] }
    }
    const [owner, name] = repo.split('/')
    const queue = await client.graphql(QUEUE_QUERY, { owner, name, branch: BASE })
    const pause = (reason) => {
      const events = laneState.paused === reason ? [] : [{ type: 'lane_paused', repo, reason }]
      laneState.paused = reason
      return { stopLane: true, events }
    }
    if (!queue.repository.mergeQueue) return pause('merge_queue_disabled: main 没开合并队列')
    const runs = await client.request('GET', `/repos/${repo}/actions/workflows/ci.yml/runs?branch=${BASE}&event=push&per_page=1`)
    const latest = runs.workflow_runs?.[0]
    if (!latest || latest.conclusion !== 'success') return pause(`main_ci_not_success: ${latest ? `${latest.status}/${latest.conclusion}` : 'no_run'}`)
    const events = laneState.paused ? [{ type: 'lane_resumed', repo }] : []
    delete laneState.paused
    return { events }
  },

  async process({ item, repoPolicy, client, facts, shadow }) {
    const pr = await facts.pr()
    if (pr.merged) return { status: 'merged', reason: 'merged_by_queue', events: [{ type: 'merged', repo: item.repo, pr: item.number, head: pr.head.sha }] }
    if (pr.state !== 'open') return { status: 'closed', reason: `pr_${pr.state}` }
    const head = pr.head.sha
    if (!item.seenHeads.includes(head)) item.seenHeads.push(head)

    const [owner, name] = item.repo.split('/')
    const gql = (await client.graphql(PR_QUERY, { owner, name, number: item.number })).repository.pullRequest

    if (item.queueState === 'enqueued') {
      if (gql.mergeQueueEntry) return { reason: `in_merge_queue: ${gql.mergeQueueEntry.state}` }
      return { status: 'dequeued', reason: '被移出合并队列且未合入（组合 CI 失败或被人移出），不自动重新入队', events: [{ type: 'dequeued', repo: item.repo, pr: item.number, head }] }
    }

    const failures = await toMivoFailures({ pr, gql, repoPolicy, facts })
    if (failures.length) return { reason: failures.join(' | ') }

    if (shadow) {
      const events = item.shadowLoggedHead === head ? [] : [{ type: 'would_enqueue', repo: item.repo, pr: item.number, head }]
      item.shadowLoggedHead = head
      return { reason: 'shadow_would_enqueue', events }
    }
    await client.graphql(ENQUEUE, { id: gql.id, oid: head })
    item.queueState = 'enqueued'
    return { reason: 'enqueued', events: [{ type: 'enqueued', repo: item.repo, pr: item.number, head }] }
  },
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
