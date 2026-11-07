// 把 GPT 单审 / e2e 的结论写成 PR head 上的 commit status，给证据门禁读。
// 这是整个仓里唯一调用 gh 的地方：证据必须由 PraiseZhu 写（门禁只认 PraiseZhu），所以用调用者本机的 gh 登录。
// 不碰 App 私钥，也不读 app.json。由做了审查或 e2e 的那个 PR 会话在拿到结论后调用。
import { execFileSync } from 'node:child_process'
import { toPatchId } from './patch-id.mjs'
import { EVIDENCE_CONTEXT } from './gates/evidence.mjs'

const RESULTS = { pass: 'success', fail: 'failure' }
const MAX_DESCRIPTION = 140

export const runGh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// 授权多写一段 pr:<owner/repo>#<号>，门禁据此确认授权属于哪个 PR（#24：授权不比对 patch-id，就要防它被共用同一提交的别的 PR 拿去用）。
// 超长时只截短 by，patch 和 pr 原样保留；连 by 都放不下就报错，不写残缺的证据。
export function toAttestDescription(patch, by, prRef = null) {
  const prefix = `patch:${patch} ${prRef ? `pr:${prRef} ` : ''}by:`
  if (prefix.length >= MAX_DESCRIPTION) throw new Error(`证据 description 超过 ${MAX_DESCRIPTION} 字：patch 和 pr 已占 ${prefix.length} 字（${prRef}）`)
  const who = String(by).replace(/\s+/g, '_').slice(0, MAX_DESCRIPTION - prefix.length)
  return `${prefix}${who}`
}

// head：审查或 e2e 实际看的那个提交。PR 在此之后又有新提交就拒绝写，免得把没审过的内容记成审过。
export function attest({ repo, pr, head, kind, result, by, gh = runGh }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error(`--repo 应为 owner/name，实际 ${repo}`)
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`--pr 应为正整数，实际 ${pr}`)
  if (!EVIDENCE_CONTEXT[kind]) throw new Error(`--kind 应为 ${Object.keys(EVIDENCE_CONTEXT).join(' | ')}，实际 ${kind}`)
  if (!RESULTS[result]) throw new Error(`--result 应为 pass | fail，实际 ${result}`)
  if (!by) throw new Error('--by 必填：写实际做审查或 e2e 的模型或执行者')
  if (!/^[0-9a-f]{40}$/.test(head ?? '')) throw new Error(`--head 应为 40 位提交 SHA（审查实际看的提交），实际 ${head}`)

  const readHead = () => gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']).trim()
  const before = readHead()
  if (before !== head) throw new Error(`PR 已有新提交：审查看的是 ${head}，当前 head 是 ${before}，请重新审查后再写证据`)
  const patch = toPatchId(gh(['api', '-H', 'Accept: application/vnd.github.diff', `repos/${repo}/pulls/${pr}`]))
  const after = readHead()
  if (after !== head) throw new Error(`读取 diff 期间 PR 有新提交（${head} → ${after}），没有写证据`)
  const status = { state: RESULTS[result], context: EVIDENCE_CONTEXT[kind], description: toAttestDescription(patch, by, kind === 'authorization' ? `${repo}#${pr}` : null) }
  gh(['api', '-X', 'POST', `repos/${repo}/statuses/${head}`, '-f', `state=${status.state}`, '-f', `context=${status.context}`, '-f', `description=${status.description}`])
  return { repo, pr, head, patch, ...status }
}
