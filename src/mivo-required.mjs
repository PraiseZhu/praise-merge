// 读 main 上实际生效的规则（GET /repos/{o}/{r}/rules/branches/main，只要 Metadata 读），
// 和 policy 里期望的必需检查逐项比对：少了任何一项、或写入方 integration 对不上，就当作规则被改松。
export async function toRequiredChecksVerdict({ client, repo, repoPolicy, branch = 'main' }) {
  const rules = await client.request('GET', `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=100`)
  const active = new Map()
  for (const rule of rules ?? []) {
    if (rule.type !== 'required_status_checks') continue
    for (const check of rule.parameters?.required_status_checks ?? []) active.set(check.context, check.integration_id ?? null)
  }
  const missing = repoPolicy.requiredChecks.filter((context) => !active.has(context))
  const wrongApp = repoPolicy.integrationId === null
    ? []
    : repoPolicy.requiredChecks.filter((context) => active.has(context) && active.get(context) !== repoPolicy.integrationId)
  if (missing.length === 0 && wrongApp.length === 0) return { ok: true }
  const parts = []
  if (missing.length) parts.push(`缺少 ${missing.join(', ')}`)
  if (wrongApp.length) parts.push(`integration 不是 ${repoPolicy.integrationId}: ${wrongApp.join(', ')}`)
  return { ok: false, reason: `required_checks_weakened: ${parts.join('；')}` }
}
