// 证据门禁：PraiseZhu 的合并授权（必需，7 天有效）、GPT 单审（必需）与 e2e（policy 为 required 时必需）。
// 授权由 pr-merge skill 在用户说「合并」时写，表达的是用户意愿，绑定 PR 而不绑定 patch-id：说过「合并」后 PR 再改，授权仍有效（#24）。
// GPT 单审和 e2e 证明的是「这一版改动」，仍绑定当前 PR 的 patch-id，PR 内容一变就作废、要重审。
// 证据是 PR 某个 head 上的 commit status：context = praise-merge/<kind>，description = "patch:<patch-id> by:<执行者>"；
// 授权的 description 是 "patch:<patch-id> pr:<owner/repo>#<号> by:<会话>"。commit status 挂在提交上、不属于哪个 PR，
// 所以授权的 pr 必须等于当前 PR；没有 pr 的旧格式授权照旧要求 patch-id 相等（先部署引擎、后更新 skill 时不放宽）。
// 先在当前 head 上找，找不到再去本 PR 以往见过的 head 上找；最新的一条必须是 PraiseZhu 写的 success（GPT 单审、e2e 还要 patch-id 等于当前 PR 的）。
import { AUTHOR, AUTH_TTL_MS } from '../policy.mjs'
import { toPatchId } from '../patch-id.mjs'

export const EVIDENCE_CONTEXT = { authorization: 'praise-merge/authorization', 'gpt-review': 'praise-merge/gpt-review', e2e: 'praise-merge/e2e' }
const PATCH_IN_DESCRIPTION = /(?:^|\s)patch:([0-9a-f]{40})(?:\s|$)/
// 不在这里校验格式：写了 pr: 但格式不对，也按「对不上」拒绝，不退回旧格式
const PR_IN_DESCRIPTION = /(?:^|\s)pr:(\S*)/

export function selectEvidencePatch(description) {
  return description?.match(PATCH_IN_DESCRIPTION)?.[1] ?? null
}

export function selectEvidencePr(description) {
  return description?.match(PR_IN_DESCRIPTION)?.[1] ?? null
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
      const verdict = await toKindVerdict({ kind, heads, facts, currentPatch, currentPr: `${item.repo}#${item.number}`, now })
      if (!verdict.ok) problems.push(verdict.reason)
    }
    return problems.length === 0 ? { ok: true } : { ok: false, reason: problems.join('; ') }
  },
}

// 只看最新的那条证据：从当前 head 往回找，找到的第一条就是结论，不让旧 head 上的 success 盖过新 head 上的 failure
async function toKindVerdict({ kind, heads, facts, currentPatch, currentPr, now }) {
  const context = EVIDENCE_CONTEXT[kind]
  for (const sha of heads) {
    const status = (await facts.checkStates(sha)).get(context)
    if (!status) continue
    // 同名 check run 会遮住这个 head 上的证据 status（facts 里 check run 优先），看不到真实结论就拒合，不去旧 head 上找
    if (status.kind !== 'status') return { ok: false, reason: `${kind}: 当前证据被同名 check run 遮住（${context}），无法确认结论` }
    if (status.creator !== AUTHOR) return { ok: false, reason: `${kind}: 写入方期望 ${AUTHOR}，实际 ${status.creator}` }
    if (status.state !== 'success') return { ok: false, reason: `${kind}=${status.state}` }
    // 写明 pr 的授权不比对 patch-id（#24）：用户说过「合并」，PR 再改也算数；但必须是给这个 PR 的授权
    const authPr = kind === 'authorization' ? selectEvidencePr(status.description) : null
    if (authPr !== null && authPr.toLowerCase() !== currentPr.toLowerCase()) return { ok: false, reason: `authorization: pr_mismatch（期望 ${currentPr}，实际 ${authPr || '空'}）` }
    const patch = selectEvidencePatch(status.description)
    if (authPr === null && patch !== currentPatch) return { ok: false, reason: `${kind}: patch_changed（证据 ${patch ?? '无'}，当前 ${currentPatch}）` }
    if (kind === 'authorization' && !(now - Date.parse(status.createdAt) <= AUTH_TTL_MS)) return { ok: false, reason: `authorization: expired（写于 ${status.createdAt}，超过 7 天，请重新说「合并」）` }
    return { ok: true }
  }
  return { ok: false, reason: `${kind}: missing（${context}）` }
}
