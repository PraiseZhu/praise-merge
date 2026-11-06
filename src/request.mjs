// 合并请求 schema praise-merge/request@1 的纯校验（不访问网络）。作者、PR 状态在 enqueue 时另查。
//
// {
//   schema: "praise-merge/request@1",
//   session_id, session_title?, machine?,
//   authorized_at: ISO 8601, authorization_text: 用户原话,
//   prs: [{ repo: "owner/name", number, head_sha_at_auth, after?: ["owner/name#n"] }]
// }
import { EXCLUDED_REPOS, selectRepoPolicy } from './policy.mjs'

export const SCHEMA = 'praise-merge/request@1'

export const toPrId = (repo, number) => `${repo.toLowerCase()}#${number}`

const PR_REF = /^[\w.-]+\/[\w.-]+#\d+$/

// 返回 { ok:true, prs:[{id, repo, number, headShaAtAuth, after:[id]}], rejected:[{id, reason}] } 或 { ok:false, reason }
export function toValidatedRequest(req, { policy, knownIds = new Set() }) {
  if (!req || typeof req !== 'object') return { ok: false, reason: 'request_not_object' }
  if (req.schema !== SCHEMA) return { ok: false, reason: `schema_mismatch: 期望 ${SCHEMA}，实际 ${String(req.schema)}` }
  for (const field of ['session_id', 'authorized_at', 'authorization_text']) {
    if (typeof req[field] !== 'string' || !req[field].trim()) return { ok: false, reason: `missing_field: ${field}` }
  }
  if (Number.isNaN(Date.parse(req.authorized_at))) return { ok: false, reason: 'authorized_at_not_iso8601' }
  if (!Array.isArray(req.prs) || req.prs.length === 0) return { ok: false, reason: 'missing_field: prs' }

  const prs = []
  const rejected = []
  for (const raw of req.prs) {
    if (typeof raw?.repo !== 'string' || !Number.isInteger(raw?.number) || typeof raw?.head_sha_at_auth !== 'string') {
      return { ok: false, reason: 'pr_entry_invalid: 需要 repo、number(整数)、head_sha_at_auth' }
    }
    const id = toPrId(raw.repo, raw.number)
    const after = (raw.after ?? []).map(String)
    const badRef = after.find((ref) => !PR_REF.test(ref))
    if (badRef) return { ok: false, reason: `after_ref_invalid: ${badRef}` }
    const entry = { id, repo: raw.repo.toLowerCase(), number: raw.number, headShaAtAuth: raw.head_sha_at_auth, after: after.map((ref) => ref.toLowerCase()) }
    if (EXCLUDED_REPOS.has(entry.repo)) rejected.push({ id, reason: 'repo_excluded' })
    else if (!selectRepoPolicy(policy, entry.repo)) rejected.push({ id, reason: 'repo_not_in_policy' })
    else prs.push(entry)
  }

  const ids = new Set(prs.map((p) => p.id))
  if (hasCycle(prs)) return { ok: false, reason: 'after_cycle' }
  const kept = []
  for (const pr of prs) {
    const unknown = pr.after.find((ref) => !ids.has(ref) && !knownIds.has(ref))
    if (unknown) rejected.push({ id: pr.id, reason: `after_unknown: ${unknown}` })
    else kept.push(pr)
  }
  return { ok: true, prs: kept, rejected }
}

function hasCycle(prs) {
  const edges = new Map(prs.map((p) => [p.id, p.after]))
  const state = new Map() // 1 = 访问中, 2 = 已完成
  const visit = (id) => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2 || !edges.has(id)) return false
    state.set(id, 1)
    const found = edges.get(id).some(visit)
    state.set(id, 2)
    return found
  }
  return prs.some((p) => visit(p.id))
}
