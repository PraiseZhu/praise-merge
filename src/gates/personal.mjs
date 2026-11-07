// 个人仓门禁。ctx = { repo, policy, pr, facts, now }；pr 是本轮读到的 PR 对象，head 以 pr.head.sha 为准。
import { ALL_CHECKS, AUTHOR } from '../policy.mjs'

const personal = (id, check) => ({ id, lanes: ['personal'], check })
const EVIDENCE_PREFIX = 'praise-merge/'
const NO_CI_GRACE_MS = 10 * 60_000

export default [
  personal('author', ({ pr }) => (pr.user?.login === AUTHOR ? { ok: true } : { ok: false, reason: `author 期望 ${AUTHOR}，实际 ${pr.user?.login}` })),

  personal('not_draft', ({ pr }) => (pr.draft ? { ok: false, reason: 'draft' } : { ok: true })),

  personal('base_is_default', async ({ pr, facts }) => {
    const { default_branch: defaultBranch } = await facts.repoInfo()
    return pr.base.ref === defaultBranch ? { ok: true } : { ok: false, reason: `base 期望 ${defaultBranch}，实际 ${pr.base.ref}` }
  }),

  personal('threads_resolved', async ({ facts }) => {
    const open = await facts.unresolvedThreads()
    return open === 0 ? { ok: true } : { ok: false, reason: `未解决讨论 ${open} 条` }
  }),

  personal('required_checks', async ({ pr, policy, facts, now }) => {
    const states = await facts.checkStates(pr.head.sha)
    if (policy.requiredChecks === ALL_CHECKS) return toAllChecksVerdict({ pr, states, facts, now })
    const bad = policy.requiredChecks
      .map((name) => [name, states.get(name)])
      .filter(([, s]) => !s?.passed)
      .map(([name, s]) => `${name}=${s?.state ?? 'missing'}`)
    return bad.length === 0 ? { ok: true } : { ok: false, reason: `必需检查未通过: ${bad.join(', ')}` }
  }),

  // 不再单设「不落后 base」门禁（#26）：落后但 GitHub 不要求同步时 mergeable_state 是 clean，直接合；
  // 要求同步时是 behind，下面这项不过，由车道 update-branch。
  // mergeable_state 按调用者计算，这里读的是 App 自己看到的值
  personal('mergeable_clean', ({ pr }) => (pr.mergeable_state === 'clean' ? { ok: true } : { ok: false, reason: `mergeable_state=${pr.mergeable_state}` })),
]

// required_checks = "all"：head 上除 praise-merge/* 证据 status 以外的全部 check run 和 commit status 都要通过。
// check run 和同名 commit status 各自判断，任一来源没过就不合。一项都没有时可能是 CI 还没出现，head 推送满 10 分钟才放行
async function toAllChecksVerdict({ pr, states, facts, now }) {
  const checks = []
  for (const [name, s] of states) {
    // 同名的两个来源分开列，原因里标明是哪一个
    const sources = s.shadowedStatus ? [[`${name}（check run）`, s], [`${name}（commit status）`, s.shadowedStatus]] : [[name, s]]
    for (const [label, state] of sources) if (!(state.kind === 'status' && name.startsWith(EVIDENCE_PREFIX))) checks.push([label, state])
  }
  if (checks.length > 0) {
    const bad = checks.filter(([, s]) => !s.passed).map(([label, s]) => `${label}=${s.state}`)
    return bad.length === 0 ? { ok: true } : { ok: false, reason: `必需检查未通过（all）: ${bad.join(', ')}` }
  }
  const pushedAt = await facts.headPushedAt(pr)
  if (now - pushedAt >= NO_CI_GRACE_MS) return { ok: true }
  return { ok: false, reason: `head 上还没有任何检查，等 CI 出现（head ${pr.head.sha.slice(0, 8)} 推送于 ${new Date(pushedAt).toISOString()}，满 10 分钟仍没有检查才放行）` }
}
