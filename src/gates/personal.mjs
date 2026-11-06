// 个人仓门禁。ctx = { repo, policy, pr, facts }；pr 是本轮读到的 PR 对象，head 以 pr.head.sha 为准。
import { AUTHOR } from '../policy.mjs'

const personal = (id, check) => ({ id, lanes: ['personal'], check })

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

  personal('required_checks', async ({ pr, policy, facts }) => {
    const states = await facts.checkStates(pr.head.sha)
    const bad = policy.requiredChecks
      .map((name) => [name, states.get(name)])
      .filter(([, s]) => !s?.passed)
      .map(([name, s]) => `${name}=${s?.state ?? 'missing'}`)
    return bad.length === 0 ? { ok: true } : { ok: false, reason: `必需检查未通过: ${bad.join(', ')}` }
  }),

  personal('up_to_date', async ({ pr, facts }) => {
    const behind = await facts.behindBy(pr.base.ref, pr.head.sha)
    return behind === 0 ? { ok: true } : { ok: false, reason: `落后 ${pr.base.ref} ${behind} 个提交` }
  }),

  // mergeable_state 按调用者计算，这里读的是 App 自己看到的值
  personal('mergeable_clean', ({ pr }) => (pr.mergeable_state === 'clean' ? { ok: true } : { ok: false, reason: `mergeable_state=${pr.mergeable_state}` })),
]
