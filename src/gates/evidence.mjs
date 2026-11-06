// 证据门禁：PraiseZhu 的合并授权（必需，7 天有效）、GPT 单审（必需）与 e2e（policy 为 required 时必需）。
// 授权由 pr-merge skill 在用户说「合并」时写；三样都绑定当前 PR 的 patch-id，PR 内容一变就全部作废。
// 证据是 PR 某个 head 上的 commit status：context = praise-merge/<kind>，description = "patch:<patch-id> by:<执行者>"。
// 先在当前 head 上找，找不到再去本 PR 以往见过的 head 上找；最新的一条必须是 PraiseZhu 写的 success，且 patch-id 等于当前 PR 的。
import { AUTHOR, AUTH_TTL_MS } from '../policy.mjs'
import { toPatchId } from '../patch-id.mjs'

export const EVIDENCE_CONTEXT = { authorization: 'praise-merge/authorization', 'gpt-review': 'praise-merge/gpt-review', e2e: 'praise-merge/e2e' }
const PATCH_IN_DESCRIPTION = /(?:^|\s)patch:([0-9a-f]{40})(?:\s|$)/

export function selectEvidencePatch(description) {
  return description?.match(PATCH_IN_DESCRIPTION)?.[1] ?? null
}

export default {
  id: 'evidence',
  lanes: ['personal'],
  async check({ pr, policy, facts, item, now }) {
    const currentPatch = toPatchId(await facts.prDiff())
    const kinds = policy.e2e === 'required' ? ['authorization', 'gpt-review', 'e2e'] : ['authorization', 'gpt-review']
    const heads = [pr.head.sha, ...[...(item.seenHeads ?? [])].reverse().filter((sha) => sha !== pr.head.sha)]
    const problems = []
    for (const kind of kinds) {
      const verdict = await toKindVerdict({ kind, heads, facts, currentPatch, now })
      if (!verdict.ok) problems.push(verdict.reason)
    }
    return problems.length === 0 ? { ok: true } : { ok: false, reason: problems.join('; ') }
  },
}

// 只看最新的那条证据：从当前 head 往回找，找到的第一条就是结论，不让旧 head 上的 success 盖过新 head 上的 failure
async function toKindVerdict({ kind, heads, facts, currentPatch, now }) {
  const context = EVIDENCE_CONTEXT[kind]
  for (const sha of heads) {
    const status = (await facts.checkStates(sha)).get(context)
    if (!status) continue
    // 同名 check run 会遮住这个 head 上的证据 status（facts 里 check run 优先），看不到真实结论就拒合，不去旧 head 上找
    if (status.kind !== 'status') return { ok: false, reason: `${kind}: 当前证据被同名 check run 遮住（${context}），无法确认结论` }
    if (status.creator !== AUTHOR) return { ok: false, reason: `${kind}: 写入方期望 ${AUTHOR}，实际 ${status.creator}` }
    if (status.state !== 'success') return { ok: false, reason: `${kind}=${status.state}` }
    const patch = selectEvidencePatch(status.description)
    if (patch !== currentPatch) return { ok: false, reason: `${kind}: patch_changed（证据 ${patch ?? '无'}，当前 ${currentPatch}）` }
    if (kind === 'authorization' && !(now - Date.parse(status.createdAt) <= AUTH_TTL_MS)) return { ok: false, reason: `authorization: expired（写于 ${status.createdAt}，超过 7 天，请重新说「合并」）` }
    return { ok: true }
  }
  return { ok: false, reason: `${kind}: missing（${context}）` }
}
