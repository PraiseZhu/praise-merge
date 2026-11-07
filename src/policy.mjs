// 读取并校验 config/policy.json 与 config/app.json。配置不合法就抛错，不带默认值硬跑。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const AUTHOR = 'PraiseZhu'
export const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000
// 用户 2026-11-06 定：这些仓不处理（cindy 无权限；另两个没点名）。policy 里写了也拒绝。
export const EXCLUDED_REPOS = new Set(['makecindy/cindy', 'xindong/mivo-canvas', 'xindong/xdmaker'])

// Mivo 只合进 main 和集成分支（用户 2026-11-07 定）。集成分支的规则集 26050842 只作用于 integration/* 一层，
// 所以这里也只认一层；再深一层的分支不受那份规则集保护，接单时就拒收。
export const MIVO_INTEGRATION_BRANCH = /^integration\/[^/]+$/
export const MIVO_ACCEPTED_BASES = 'main 或 integration/*'
// 集成分支上审查机写的检查叫 review-pr (integration)，其余必需检查和 main 同名（规则集 26050842，2026-11-07 查）
export const MIVO_INTEGRATION_REVIEW_CHECK = 'review-pr (integration)'
// 集成分支用 merge：最近 5 个合进 integration/* 的 PR 3 个用 merge、2 个用 squash（#1957 #1935 #1861 #1852 #1840），
// squash 会丢掉同步 main 时的祖先关系（#1840），merge 不会；规则集允许 squash 和 merge
export const MIVO_INTEGRATION_MERGE_METHOD = 'merge'

export const isMivoBase = (ref) => ref === 'main' || MIVO_INTEGRATION_BRANCH.test(ref ?? '')

const LANES = new Set(['personal', 'mivo'])
const MERGE_METHODS = new Set(['squash', 'merge', 'rebase'])

export function toPolicy(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.repos !== 'object') throw new Error('policy.json 缺少 repos 对象')
  const repos = {}
  for (const [name, entry] of Object.entries(raw.repos)) {
    const key = name.toLowerCase()
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`policy 仓名格式不对: ${name}`)
    if (EXCLUDED_REPOS.has(key)) throw new Error(`policy 里不能出现排除仓: ${name}`)
    if (!LANES.has(entry.lane)) throw new Error(`${name}.lane 应为 personal 或 mivo，实际 ${entry.lane}`)
    if (!Array.isArray(entry.required_checks) || entry.required_checks.length === 0) throw new Error(`${name}.required_checks 至少一项`)
    const e2e = entry.e2e ?? 'n_a'
    if (!['required', 'n_a'].includes(e2e)) throw new Error(`${name}.e2e 应为 required 或 n_a，实际 ${e2e}`)
    const mergeMethod = entry.merge_method ?? 'squash'
    if (!MERGE_METHODS.has(mergeMethod)) throw new Error(`${name}.merge_method 不支持: ${mergeMethod}`)
    const integrationId = entry.checks_integration_id ?? null
    if (integrationId !== null && !Number.isInteger(integrationId)) throw new Error(`${name}.checks_integration_id 应为整数`)
    repos[key] = { name, lane: entry.lane, requiredChecks: entry.required_checks.map(String), e2e, mergeMethod, integrationId }
  }
  return { repos }
}

export function toAppConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('app.json 不是对象')
  if (!Number.isInteger(raw.app_id)) throw new Error('app.json.app_id 应为整数')
  if (typeof raw.key_path !== 'string' || !raw.key_path) throw new Error('app.json.key_path 缺失')
  if (!raw.installations || typeof raw.installations !== 'object') throw new Error('app.json.installations 缺失')
  const installations = {}
  for (const [owner, id] of Object.entries(raw.installations)) {
    if (!Number.isInteger(id)) throw new Error(`installations.${owner} 应为整数`)
    installations[owner.toLowerCase()] = id
  }
  // 影子模式默认开：只有显式写 false 才真的写 GitHub
  return { appId: raw.app_id, keyPath: raw.key_path, installations, shadow: raw.shadow !== false }
}

export function selectRepoPolicy(policy, repo) {
  return policy.repos[repo.toLowerCase()] ?? null
}

export function readConfig(configDir) {
  const read = (file) => JSON.parse(readFileSync(join(configDir, file), 'utf8'))
  return { app: toAppConfig(read('app.json')), policy: toPolicy(read('policy.json')) }
}
