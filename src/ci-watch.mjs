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
// 找弄红它的提交时最多往回走几步；走满还没碰到绿的提交就按「找不准」处理
export const MAX_CAUSE_STEPS = 10

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
  // conclusion 只给 findRedCause 用：被取消的 run 在分支头照旧算红，但往回找弄红它的提交时不算失败
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

// 集成分支的负责人（#53）：同仓、源分支是它的开放 PR（合回 main 的阶段 PR）的作者；没有阶段 PR 就取目标分支是它的开放 PR 的作者。
// 多个人都算，按 PR 号排，去重。机器人账号不在这里筛，发送时才判断（见 src/red-notice.mjs）
export function toBranchOwners(prs, repo, branch) {
  const sorted = [...(prs ?? [])].sort((a, b) => a.number - b.number)
  const stage = sorted.filter((pr) => pr.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() && pr.head?.ref === branch)
  const used = stage.length ? stage : sorted.filter((pr) => pr.base?.ref === branch)
  return toDistinctLogins(used.map((pr) => pr.user?.login))
}

// 提交关联的 PR 里，把这个提交合进分支的那一个：合并提交就是它的；没有就取已合并、目标分支是这个分支的；都没有返回 null（直接推送）。
// 只是「包含这个提交」的开放 PR（如集成分支合回 main 的阶段 PR）不算
export function selectCausePull(pulls, { sha, branch }) {
  const list = pulls ?? []
  return list.find((pr) => pr.merge_commit_sha === sha) ?? list.find((pr) => pr.merged_at && pr.base?.ref === branch) ?? null
}

// 这一轮红是从哪个提交开始的、它是哪个 PR 合进来的（#53）。按最新提交找人会找错：
// 2026-11-20 integration/generation-recovery 是 #2599 合入后变红的，之后 #2612 又合进来，分支头是 #2612 的提交。
// 从红的分支头沿第一父提交往回找：父提交在这个分支上 push 触发的 CI 也失败就继续往回；父提交是绿的就停，找准了（certain=true）。
// 父提交没有 CI 结论（还在跑、被取消、没有 run、读不到）或走满 MAX_CAUSE_STEPS 步也停，只能说「最早确认变红」（certain=false）。
// 返回 { sha, pr, author, certain }：pr 没有对应的 PR 时是 null；author 是 PR 作者，没有 PR 时是提交的 GitHub 作者账号，都没有是 null。
// 读 GitHub 失败会抛错，由 withRedCause 接住。
export async function findRedCause({ client, repo, branch, sha, toCheckVerdict }) {
  const readCommit = (ref) => client.request('GET', `/repos/${repo}/commits/${ref}`)
  let cause = sha
  let commit = await readCommit(cause)
  let certain = false
  const seen = new Set([sha])
  for (let step = 0; step < MAX_CAUSE_STEPS; step++) {
    const parent = commit.parents?.[0]?.sha
    if (!parent || seen.has(parent)) break
    seen.add(parent)
    let ci
    try {
      ci = await toBranchCiState({ client, repo, branch, sha: parent, toCheckVerdict })
    } catch {
      break // 父提交的 CI 读不到：按没有结论处理，停在当前提交
    }
    if (ci.state === 'green') {
      certain = true
      break
    }
    if (ci.state !== 'red' || ci.conclusion === 'cancelled') break
    cause = parent
    commit = await readCommit(cause)
  }
  const pull = selectCausePull(await client.request('GET', `/repos/${repo}/commits/${cause}/pulls?per_page=100`), { sha: cause, branch })
  return { sha: cause, pr: pull?.number ?? null, author: pull?.user?.login ?? commit.author?.login ?? null, certain }
}

// 给红灯事件补上弄红它的 PR。查不到（读 GitHub 失败）不挡红灯：cause 记 null（飞书转给兜底收件人），另记一条 ci_watch_failed（只进日志）
export async function withRedCause({ client, repo, events, toCheckVerdict }) {
  const out = []
  for (const ev of events) {
    if (!RED_EVENT_TYPES.has(ev.type)) {
      out.push(ev)
      continue
    }
    try {
      out.push({ ...ev, cause: await findRedCause({ client, repo, branch: ev.branch, sha: ev.head, toCheckVerdict }) })
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
