// CI 红灯监视（#48，2026-11-12 用户定：「我的集成分支 CI 变红时给我发飞书通知；main 红时也给我发飞书通知」）。
// 只报真红：分支当前提交 push 触发的 ci.yml 已结束且结论不是 success，或 ci.yml 成功但同一提交上 push 触发的其他检查
// 已结束失败、commit status 是 failure / error。还在跑、读不到、来源未知都不算红，不报。
// 同一分支同一提交只报一次；集成分支转绿报一次恢复（main 转绿沿用 lane_resumed）。
// 事件交给伙伴，由伙伴用飞书机器人发给用户（见 docs/operations.md「CI 变红飞书通知」）。
export const INTEGRATION_PREFIX = 'integration/'
export const RED_EVENT_TYPES = new Set(['main_ci_red', 'integration_ci_red'])
const MAX_LISTED = 10

// 在用的集成分支：开放 PR 的目标分支，或同仓 PR 的源分支（集成分支合回 main 的阶段 PR），是 integration/* 的
export function toWatchedBranches(prs, repo) {
  const used = new Map()
  const add = (branch, number) => {
    if (!used.has(branch)) used.set(branch, new Set())
    used.get(branch).add(number)
  }
  for (const pr of prs ?? []) {
    if (pr.base?.ref?.startsWith(INTEGRATION_PREFIX)) add(pr.base.ref, pr.number)
    const sameRepo = !pr.head?.repo || pr.head.repo.full_name?.toLowerCase() === repo.toLowerCase()
    if (sameRepo && pr.head?.ref?.startsWith(INTEGRATION_PREFIX)) add(pr.head.ref, pr.number)
  }
  return new Map([...used].sort(([a], [b]) => a.localeCompare(b)).map(([branch, prs]) => [branch, [...prs].sort((x, y) => x - y)]))
}

const toList = (items) => (items.length > MAX_LISTED ? `${items.slice(0, MAX_LISTED).join(', ')} 等 ${items.length} 项` : items.join(', '))

// 分支当前提交的 CI 状态：red（带失败项）/ green / pending。ci.yml 的 run 已经读过时传 ciRun，省一次请求
export async function toBranchCiState({ client, repo, branch, sha, toCheckVerdict, ciRun }) {
  const run = ciRun !== undefined ? ciRun
    : (await client.request('GET', `/repos/${repo}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&event=push&head_sha=${sha}&per_page=1`)).workflow_runs?.[0] ?? null
  if (!run || run.status !== 'completed') return { state: 'pending' }
  if (run.conclusion !== 'success') return { state: 'red', detail: `CI=${run.conclusion}` }
  const verdict = await toCheckVerdict({ client, repo, sha })
  if (verdict.readError) return { state: 'pending' }
  if (verdict.failed.length) return { state: 'red', detail: toList([...verdict.failed].sort()) }
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
        events.push({ type: 'integration_ci_red', repo, branch, head: sha, reason: `${branch} ${sha.slice(0, 8)} ${ci.detail}（在用的 PR：${numbers.map((n) => `#${n}`).join('、')}）` })
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
