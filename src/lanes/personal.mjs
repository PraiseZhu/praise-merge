// 个人仓车道：同一仓一次只动一个 PR。合并后等 base 分支 CI 出结论再合下一个；base 红了就冻结车道。
import { selectLaneGates, toGateFailures } from '../gates/index.mjs'
import { GitHubError } from '../github.mjs'

// 只在 GitHub 要求先同步（mergeable_state=behind）时替 PR 追 base；落后但 clean 就直接合，不追（#26）。
// 追完会换 head、CI 重跑，所以只差这些门禁时才追，讨论、Draft、证据等先要满足
const UPDATE_OK = new Set(['required_checks', 'mergeable_clean'])
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])
const NO_CI_GRACE_MS = 10 * 60_000

export default {
  id: 'personal',
  // 每轮先于条目调用（即使队列里已经没有这个仓的 PR）：合并后等 base CI，红了冻结车道
  async beforeItems({ repo, laneState, client, now }) {
    if (!laneState.pendingBaseCheck) return {}
    const verdict = await toBaseVerdict(client, repo, laneState.pendingBaseCheck, now)
    if (verdict === 'pending') return { stopLane: true }
    if (verdict === 'failure') {
      laneState.frozen = { reason: `base_ci_failed: ${laneState.pendingBaseCheck.sha}`, at: new Date(now).toISOString() }
      delete laneState.pendingBaseCheck
      return { stopLane: true, events: [{ type: 'lane_frozen', repo, reason: laneState.frozen.reason }] }
    }
    delete laneState.pendingBaseCheck
    return { events: [{ type: 'base_ci_passed', repo }] }
  },

  async process(env) {
    const { item, repoPolicy, laneState, client, facts, gates, now, shadow } = env

    const pr = await facts.pr()
    if (pr.merged) return { status: 'merged', reason: 'merged_elsewhere' }
    if (pr.state !== 'open') return { status: 'closed', reason: `pr_${pr.state}` }
    const head = pr.head.sha
    if (!item.seenHeads.includes(head)) item.seenHeads.push(head)

    const failures = await toGateFailures(selectLaneGates(gates, 'personal'), { repo: item.repo, policy: repoPolicy, pr, facts, item, now })

    if (failures.length === 0) {
      if (shadow) {
        const events = item.shadowLoggedHead === head ? [] : [{ type: 'would_merge', repo: item.repo, pr: item.number, head }]
        item.shadowLoggedHead = head
        return { stopLane: true, reason: 'shadow_would_merge', events }
      }
      try {
        const res = await client.request('PUT', `/repos/${item.repo}/pulls/${item.number}/merge`, { sha: head, merge_method: repoPolicy.mergeMethod })
        laneState.pendingBaseCheck = { sha: res.sha, since: now }
        return { status: 'merged', reason: `merged ${res.sha}`, stopLane: true, events: [{ type: 'merged', repo: item.repo, pr: item.number, head, mergeSha: res.sha }] }
      } catch (err) {
        if (!(err instanceof GitHubError) || ![405, 409, 422].includes(err.status)) throw err
        return { stopLane: true, reason: `merge_refused: ${err.message}`, events: [{ type: 'merge_refused', repo: item.repo, pr: item.number, reason: err.message }] }
      }
    }

    const reason = failures.map((f) => `${f.id}: ${f.reason}`).join(' | ')
    if (pr.mergeable_state === 'behind' && failures.every((f) => UPDATE_OK.has(f.id))) {
      if (shadow) {
        const events = item.shadowLoggedHead === `update:${head}` ? [] : [{ type: 'would_update_branch', repo: item.repo, pr: item.number, head }]
        item.shadowLoggedHead = `update:${head}`
        return { stopLane: true, reason: `shadow_would_update_branch | ${reason}`, events }
      }
      await client.request('PUT', `/repos/${item.repo}/pulls/${item.number}/update-branch`, { expected_head_sha: head })
      return { stopLane: true, reason: `update_branch_requested | ${reason}`, events: [{ type: 'update_branch', repo: item.repo, pr: item.number, head }] }
    }
    return { reason }
  },
}

async function toBaseVerdict(client, repo, { sha, since }, now) {
  const data = await client.request('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100`)
  const runs = data.check_runs ?? []
  const status = await client.request('GET', `/repos/${repo}/commits/${sha}/status`)
  const statuses = status.statuses ?? []
  if (runs.some((r) => r.status === 'completed' && FAILING.has(r.conclusion)) || statuses.some((s) => FAILING.has(s.state))) return 'failure'
  if (runs.some((r) => r.status !== 'completed') || statuses.some((s) => s.state === 'pending')) return 'pending'
  if (runs.length === 0 && statuses.length === 0 && now - since < NO_CI_GRACE_MS) return 'pending'
  return 'success'
}
