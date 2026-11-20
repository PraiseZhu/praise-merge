// CI 红灯监视（#48，2026-11-12 用户定：「我的集成分支 CI 变红时给我发飞书通知；main 红时也给我发飞书通知」）。
// 只报真红：分支当前提交 push 触发的 ci.yml 已结束且结论不是 success，或 ci.yml 成功但同一提交上 push 触发的其他检查
// 已结束失败、commit status 是 failure / error。还在跑、读不到、来源未知都不算红，不报。
// 同一分支同一提交只报一次；集成分支转绿报一次恢复（main 转绿沿用 lane_resumed）。
// 事件交给伙伴，由伙伴用飞书机器人发给用户（见 docs/operations.md「CI 变红飞书通知」）。
// 红灯事件带上该通知谁（#53，2026-11-20 用户定：「谁的 pr 让 main 红了飞书通知谁；谁的集成分支红了飞书通知谁」）：
// cause 是弄红它的 PR（findRedCause），owners 是集成分支的负责人（toBranchOwners）。这里只有 GitHub 账号，邮箱在发送时才查。
import { toDistinctLogins } from './roster.mjs'

export const INTEGRATION_PREFIX = 'integration/'
export const RED_EVENT_TYPES = new Set(['main_ci_red', 'integration_ci_red'])
const MAX_LISTED = 10
const MAIN_BRANCH = 'main'
// 找弄红它的提交时最多往回走几步、最多花多久；走满或超时还没碰到绿的提交就按「找不准」处理
export const MAX_CAUSE_STEPS = 10
export const CAUSE_WALK_TIMEOUT_MS = 20_000
// 读「提交关联的 PR」的限时。往回找和这一步都限时：GitHub 请求卡住时不能把整轮巡检拖到超时、连红灯事件一起丢掉
export const CAUSE_PULLS_TIMEOUT_MS = 8_000
// 往回找时 ci.yml 的这些结论才算确实失败；被取消、被跳过、等人工操作、没有结论都算没法确认
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])

// 在用的集成分支：开放 PR 的目标分支，或同仓 PR 的源分支（集成分支合回 main 的阶段 PR），是 integration/* 的
export function toWatchedBranches(prs, repo) {
  const used = new Map()
  const add = (branch, number) => {
    if (!used.has(branch)) used.set(branch, new Set())
    used.get(branch).add(number)
  }
  for (const pr of prs ?? []) {
    if (pr.base?.ref?.startsWith(INTEGRATION_PREFIX)) add(pr.base.ref, pr.number)
    // 源仓库必须明确是本仓：fork 删掉后 GitHub 给 head.repo=null，不能当成本仓的分支
    const sameRepo = pr.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase()
    if (sameRepo && pr.head?.ref?.startsWith(INTEGRATION_PREFIX)) add(pr.head.ref, pr.number)
  }
  return new Map([...used].sort(([a], [b]) => a.localeCompare(b)).map(([branch, prs]) => [branch, [...prs].sort((x, y) => x - y)]))
}

const toList = (items) => (items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')} 等 ${items.length} 项` : items.join(', '))

// 判红用的失败项：明细里的失败，加上「看得见的都是 pending、聚合却是 failure / error」时的聚合状态（hiddenFailed）
export const toRedFailures = (verdict) => [...verdict.failed, ...(verdict.hiddenFailed ?? [])]

// 分支当前提交的 CI 状态：red（带失败项）/ green / pending。ci.yml 的 run 已经读过时传 ciRun，省一次请求
export async function toBranchCiState({ client, repo, branch, sha, toCheckVerdict, ciRun }) {
  const run = ciRun !== undefined ? ciRun
    : (await client.request('GET', `/repos/${repo}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&event=push&head_sha=${sha}&per_page=1`)).workflow_runs?.[0] ?? null
  if (!run || run.status !== 'completed') return { state: 'pending' }
  // conclusion 只给 findRedCause 用：被取消、被跳过、没有结论的 run 在分支头照旧算红，但往回找弄红它的提交时不算确实失败
  if (run.conclusion !== 'success') return { state: 'red', detail: `CI=${run.conclusion}`, conclusion: run.conclusion }
  const verdict = await toCheckVerdict({ client, repo, sha })
  if (verdict.readError) return { state: 'pending' }
  const failures = toRedFailures(verdict)
  if (failures.length) return { state: 'red', detail: toList([...failures].sort()) }
  if (verdict.unfinished.length || verdict.unknown.length || verdict.empty) return { state: 'pending' }
  return { state: 'green' }
}

// main 红灯：同一提交只报一次（laneState.mainRedSha）；转绿时清掉，同一提交重跑又红会再报
export function toMainRedEvents({ repo, laneState, sha, ci }) {
  if (ci.state === 'green') {
    delete laneState.mainRedSha
    return []
  }
  if (ci.state !== 'red' || laneState.mainRedSha === sha) return []
  laneState.mainRedSha = sha
  return [{ type: 'main_ci_red', repo, branch: 'main', head: sha, reason: `main ${sha.slice(0, 8)} ${ci.detail}` }]
}

// 集成分支的负责人（#53）：同仓、源分支是它、目标分支是 main 的开放 PR（合回 main 的阶段 PR）的作者；没有阶段 PR 就取目标分支是它的开放 PR 的作者。
// 源分支是它、但合进别的集成分支的 PR 不算阶段 PR。多个人都算，按 PR 号排，去重。机器人账号不在这里筛，发送时才判断（见 src/red-notice.mjs）
export function toBranchOwners(prs, repo, branch) {
  const sorted = [...(prs ?? [])].sort((a, b) => a.number - b.number)
  const stage = sorted.filter((pr) => pr.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() && pr.head?.ref === branch && pr.base?.ref === MAIN_BRANCH)
  const used = stage.length ? stage : sorted.filter((pr) => pr.base?.ref === branch)
  return toDistinctLogins(used.map((pr) => pr.user?.login))
}

// 提交关联的 PR 里，把这个提交合进分支的那一个：合并提交就是它的；没有就取已合并、目标分支是这个分支的；都没有返回 null（直接推送）。
// 只是「包含这个提交」的开放 PR（如集成分支合回 main 的阶段 PR）不算。pulls 必须是列表：应答异常由 findRedCause 按读失败处理，不在这里当成「没有 PR」
export function selectCausePull(pulls, { sha, branch }) {
  return pulls.find((pr) => pr.merge_commit_sha === sha) ?? pulls.find((pr) => pr.merged_at && pr.base?.ref === branch) ?? null
}

// 给 client 的每个请求带上同一个中止信号（限时用）
const withSignal = (client, signal) => ({ ...client, request: (method, path, body, opts = {}) => client.request(method, path, body, { ...opts, signal }) })

// 往回找时，这个父提交算不算「确实失败」：ci.yml 结论是失败类，或 ci.yml 成功但别的 push 检查失败（这时没有 conclusion）
const isFailedForCause = (ci) => ci.state === 'red' && (ci.conclusion === undefined || FAILED_CONCLUSIONS.has(ci.conclusion))

// 这一轮红是从哪个提交开始的、它是哪个 PR 合进来的（#53）。按最新提交找人会找错：
// 2026-11-20 integration/generation-recovery 是 #2599 合入后变红的，之后 #2612 又合进来，分支头是 #2612 的提交。
// 从红的分支头沿第一父提交往回找：父提交在这个分支上 push 触发的 CI 确实失败（isFailedForCause）就继续往回；父提交是绿的就停，找准了（certain=true）。
// 父提交没法确认（还在跑、被取消、被跳过、没有结论、没有 run、读不到）、走满 MAX_CAUSE_STEPS 步、或往回找超过 walkTimeoutMs 也停，
// 只能说「最早确认变红」（certain=false）。往回找途中的读失败只是停在已确认的提交上，不算查不到。
// 返回 { sha, pr, author, certain }：pr 没有对应的 PR 时是 null；author 是 PR 作者，没有 PR 时是提交的 GitHub 作者账号，都没有是 null。
// 读分支头提交、读提交关联的 PR 失败、超时或应答异常会抛错，由 withRedCause 接住（cause 记 null）。
export async function findRedCause({ client, repo, branch, sha, toCheckVerdict, walkTimeoutMs = CAUSE_WALK_TIMEOUT_MS, pullsTimeoutMs = CAUSE_PULLS_TIMEOUT_MS }) {
  const walker = withSignal(client, AbortSignal.timeout(walkTimeoutMs))
  const readCommit = async (ref) => {
    const commit = await walker.request('GET', `/repos/${repo}/commits/${ref}`)
    if (!commit || typeof commit !== 'object') throw new Error(`提交 ${ref.slice(0, 8)} 的应答不是对象`)
    return commit
  }
  let cause = sha
  let commit = await readCommit(cause)
  let certain = false
  const seen = new Set([sha])
  for (let step = 0; step < MAX_CAUSE_STEPS; step++) {
    const parent = commit.parents?.[0]?.sha
    if (!parent || seen.has(parent)) break
    seen.add(parent)
    let parentCommit
    try {
      const ci = await toBranchCiState({ client: walker, repo, branch, sha: parent, toCheckVerdict })
      if (ci.state === 'green') {
        certain = true
        break
      }
      if (!isFailedForCause(ci)) break
      parentCommit = await readCommit(parent)
    } catch {
      break // 父提交读不到或超时：按没法确认处理，停在当前提交
    }
    cause = parent
    commit = parentCommit
  }
  const pulls = await withSignal(client, AbortSignal.timeout(pullsTimeoutMs)).request('GET', `/repos/${repo}/commits/${cause}/pulls?per_page=100`)
  if (!Array.isArray(pulls)) throw new Error(`提交 ${cause.slice(0, 8)} 关联的 PR 应答不是列表`)
  const pull = selectCausePull(pulls, { sha: cause, branch })
  return { sha: cause, pr: pull?.number ?? null, author: pull?.user?.login ?? commit.author?.login ?? null, certain }
}

// 给红灯事件补上弄红它的 PR。查不到（读 GitHub 失败、超时、应答异常）不挡红灯：cause 记 null（飞书转给兜底收件人），另记一条 ci_watch_failed（只进日志）。
// timeouts：{ walkTimeoutMs, pullsTimeoutMs }，测试用，默认见上面两个常量
export async function withRedCause({ client, repo, events, toCheckVerdict, timeouts = {} }) {
  const out = []
  for (const ev of events) {
    if (!RED_EVENT_TYPES.has(ev.type)) {
      out.push(ev)
      continue
    }
    try {
      out.push({ ...ev, cause: await findRedCause({ client, repo, branch: ev.branch, sha: ev.head, toCheckVerdict, ...timeouts }) })
    } catch (err) {
      out.push({ ...ev, cause: null }, { type: 'ci_watch_failed', repo, branch: ev.branch, reason: `${ev.branch} 查弄红它的 PR 失败（${err.message}）` })
    }
  }
  return out
}

// 每轮看一遍在用的集成分支。状态记在 laneState.ciWatch[分支]：redSha 报过红的提交，greenSha 判过绿的提交（不再重查）。
// openPrs：自动接单本轮已经拉到的开放 PR 列表，有就复用，一轮只发一次列表请求；没有（没开自动接单、列表请求失败）才自己拉。
// 读开放 PR 或某个分支失败不打断本轮，只产生 ci_watch_failed（只进日志，不叫醒伙伴）。
export async function watchIntegrationBranches({ repo, client, laneState, toCheckVerdict, openPrs }) {
  let prs = openPrs
  if (!prs) {
    try {
      prs = await client.request('GET', `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`)
    } catch (err) {
      return [{ type: 'ci_watch_failed', repo, reason: `列开放 PR 失败（${err.message}）` }]
    }
  }
  const prev = laneState.ciWatch ?? {}
  const next = {}
  const events = []
  for (const [branch, numbers] of toWatchedBranches(prs, repo)) {
    const state = { ...prev[branch] }
    next[branch] = state
    let sha
    let ci
    try {
      sha = (await client.request('GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`)).commit.sha
      if (state.greenSha === sha) continue
      ci = await toBranchCiState({ client, repo, branch, sha, toCheckVerdict })
    } catch (err) {
      events.push({ type: 'ci_watch_failed', repo, branch, reason: `${branch} 读取失败（${err.message}）` })
      continue
    }
    if (ci.state === 'red') {
      delete state.greenSha
      if (state.redSha !== sha) {
        state.redSha = sha
        const red = { type: 'integration_ci_red', repo, branch, head: sha, reason: `${branch} ${sha.slice(0, 8)} ${ci.detail}（在用的 PR：${numbers.map((n) => `#${n}`).join('、')}）`, owners: toBranchOwners(prs, repo, branch) }
        events.push(...await withRedCause({ client, repo, events: [red], toCheckVerdict }))
      }
    } else if (ci.state === 'green') {
      if (state.redSha) events.push({ type: 'integration_ci_recovered', repo, branch, head: sha, reason: `${branch} ${sha.slice(0, 8)}` })
      delete state.redSha
      state.greenSha = sha
    } else {
      delete state.greenSha
    }
  }
  if (Object.keys(next).length) laneState.ciWatch = next
  else delete laneState.ciWatch
  return events
}
