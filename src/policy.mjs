// 读取并校验 config/policy.json 与 config/app.json。配置不合法就抛错，不带默认值硬跑。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const AUTHOR = 'PraiseZhu'
// Mivo 车道另认 praise-qa App 开的 PR（用户 2026-11-08 定；审查机 PraiseZhu/Review-PR#223 已定它和本人同权）。
// 写法是 REST 的 user.login；个人仓车道仍只认 PraiseZhu
export const MIVO_BOT_AUTHOR = 'praise-qa[bot]'
const LANE_AUTHORS = { personal: [AUTHOR], mivo: [AUTHOR, MIVO_BOT_AUTHOR] }
export const selectLaneAuthors = (lane) => LANE_AUTHORS[lane] ?? []
// 作者不在这条车道的名单里时返回带期望值和实际值的原因，在名单里返回 null
export function toAuthorMismatch(lane, login) {
  const authors = selectLaneAuthors(lane)
  return authors.includes(login) ? null : `期望 ${authors.join(' 或 ')}，实际 ${login}`
}
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

// auto_intake.base 里的通配：全部集成分支（#42：合进集成分支的本人 PR 和 bot PR 也自动接单）
export const MIVO_INTEGRATION_WILDCARD = 'integration/*'
// PR 的目标分支是否在 auto_intake.base 列出的分支里（逐项比；integration/* 匹配任一层集成分支）
export const toIntakeBaseMatch = (bases, ref) => bases.some((b) => b === ref || (b === MIVO_INTEGRATION_WILDCARD && MIVO_INTEGRATION_BRANCH.test(ref ?? '')))

const LANES = new Set(['personal', 'mivo'])
const MERGE_METHODS = new Set(['squash', 'merge', 'rebase'])
// required_checks 写 "all"：head 上除 praise-merge/* 证据以外的全部检查都要通过（只用于个人仓车道）
export const ALL_CHECKS = 'all'
// 默认条目只认 PraiseZhu/*（用户 2026-11-07 定：伙伴要能合 PraiseZhu 名下全部仓，含 fork），只走个人仓车道
const DEFAULT_ENTRY_OWNERS = new Set(['praisezhu'])

export function toPolicy(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.repos !== 'object') throw new Error('policy.json 缺少 repos 对象')
  const repos = {}
  const defaults = {}
  for (const [name, entry] of Object.entries(raw.repos)) {
    const key = name.toLowerCase()
    const wildcard = /^[\w.-]+\/\*$/.test(name)
    if (!wildcard && !/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`policy 仓名格式不对: ${name}`)
    if (EXCLUDED_REPOS.has(key)) throw new Error(`policy 里不能出现排除仓: ${name}`)
    if (!LANES.has(entry.lane)) throw new Error(`${name}.lane 应为 personal 或 mivo，实际 ${entry.lane}`)
    const owner = key.split('/')[0]
    if (wildcard && !DEFAULT_ENTRY_OWNERS.has(owner)) throw new Error(`policy 通配条目只支持 PraiseZhu/*，实际 ${name}`)
    if (wildcard && entry.lane !== 'personal') throw new Error(`${name} 是通配条目，lane 只能是 personal，实际 ${entry.lane}`)
    const allChecks = entry.required_checks === ALL_CHECKS
    if (allChecks && entry.lane !== 'personal') throw new Error(`${name}.required_checks 写 "${ALL_CHECKS}" 只能用于 personal 车道`)
    if (!allChecks && (!Array.isArray(entry.required_checks) || entry.required_checks.length === 0)) throw new Error(`${name}.required_checks 至少一项，或写 "${ALL_CHECKS}"`)
    // 默认条目也要 e2e（用户 2026-11-07 定，和逐仓条目里的个人仓一致）
    const e2e = entry.e2e ?? (wildcard ? 'required' : 'n_a')
    if (!['required', 'n_a'].includes(e2e)) throw new Error(`${name}.e2e 应为 required 或 n_a，实际 ${e2e}`)
    if (wildcard && e2e !== 'required') throw new Error(`${name} 是通配条目，e2e 必须是 required，实际 ${e2e}`)
    const mergeMethod = entry.merge_method ?? 'squash'
    if (!MERGE_METHODS.has(mergeMethod)) throw new Error(`${name}.merge_method 不支持: ${mergeMethod}`)
    const integrationId = entry.checks_integration_id ?? null
    if (integrationId !== null && !Number.isInteger(integrationId)) throw new Error(`${name}.checks_integration_id 应为整数`)
    const autoIntake = entry.auto_intake === undefined ? null : toAutoIntake(name, entry)
    const parsed = { name, lane: entry.lane, requiredChecks: allChecks ? ALL_CHECKS : entry.required_checks.map(String), e2e, mergeMethod, integrationId, autoIntake }
    if (wildcard) defaults[owner] = parsed
    else repos[key] = parsed
  }
  return { repos, defaults }
}

// auto_intake：每轮自动接单的条件（见 src/auto-intake.mjs）。只能写在 mivo 车道的逐仓条目上（通配条目只能是 personal，也就写不了）
function toAutoIntake(name, entry) {
  const raw = entry.auto_intake
  if (entry.lane !== 'mivo') throw new Error(`${name}.auto_intake 只能写在 lane 为 mivo 的条目上，实际 lane ${entry.lane}`)
  if (!raw || typeof raw !== 'object') throw new Error(`${name}.auto_intake 应为对象`)
  const allowed = selectLaneAuthors('mivo')
  if (!Array.isArray(raw.authors) || raw.authors.length === 0) throw new Error(`${name}.auto_intake.authors 至少一项`)
  const stranger = raw.authors.find((login) => !allowed.includes(login))
  if (stranger !== undefined) throw new Error(`${name}.auto_intake.authors 只能是 ${allowed.join(' 或 ')}，实际 ${stranger}`)
  if (typeof raw.label !== 'string' || !raw.label.trim()) throw new Error(`${name}.auto_intake.label 缺失`)
  // base 写一个分支或数组；每项是 main、具体的 integration/<名>，或 integration/*（全部集成分支）
  const bases = Array.isArray(raw.base) ? raw.base : [raw.base]
  // git 分支名不能带 * ? [，除了 integration/* 这一个通配写法，带这些字符的都按写错拒收
  // 用下标找：漏写 base（[undefined]）时 find 会返回 undefined，被当成「没有写错的项」放过去
  const bad = bases.findIndex((b) => b !== MIVO_INTEGRATION_WILDCARD && (typeof b !== 'string' || /[*?[]/.test(b) || !isMivoBase(b)))
  if (bases.length === 0 || bad !== -1) throw new Error(`${name}.auto_intake.base 应为 ${MIVO_ACCEPTED_BASES}，实际 ${bases.length === 0 ? '[]' : String(bases[bad])}`)
  // 标签必须是这些账号挂的（审查机 praisebuild[bot]，写入关闭时退回 PraiseZhu）：只有 Triage 权限的人挂标签不能触发 App 合并
  const actors = raw.label_actors
  if (!Array.isArray(actors) || actors.length === 0 || actors.some((login) => typeof login !== 'string' || !login.trim())) throw new Error(`${name}.auto_intake.label_actors 至少一项，且每项是非空字符串`)
  // 这些作者的 PR 只有正文里「合并顺序：」有效才接单，依赖按正文排队（#38：本人 PR 由会话把顺序写进正文，伙伴不盲合）
  const orderLineAuthors = raw.order_line_authors ?? []
  if (!Array.isArray(orderLineAuthors)) throw new Error(`${name}.auto_intake.order_line_authors 应为数组`)
  const outsider = orderLineAuthors.find((login) => !raw.authors.includes(login))
  if (outsider !== undefined) throw new Error(`${name}.auto_intake.order_line_authors 只能是 authors 里的账号（${raw.authors.join('、')}），实际 ${outsider}`)
  return { authors: [...raw.authors], label: raw.label, bases: [...bases], labelActors: [...actors], orderLineAuthors: [...orderLineAuthors] }
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

// 逐仓条目优先，没有再用这个 owner 的默认条目（PraiseZhu/*）；排除仓一律没有条目
export function selectRepoPolicy(policy, repo) {
  const key = repo.toLowerCase()
  if (EXCLUDED_REPOS.has(key)) return null
  return policy.repos[key] ?? policy.defaults?.[key.split('/')[0]] ?? null
}

export function readConfig(configDir) {
  const read = (file) => JSON.parse(readFileSync(join(configDir, file), 'utf8'))
  return { app: toAppConfig(read('app.json')), policy: toPolicy(read('policy.json')) }
}
