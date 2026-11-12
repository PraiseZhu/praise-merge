// Mivo 车道：门禁全过后，目标分支开着合并队列就用 App 入队（组合测试和合并由队列完成）；
// 没开队列就由 App 直接合并（锁定检查过的 head）。
// 目标分支只有 main 和 integration/*（接单时已拒收其他分支）。集成分支的门槛不低于 main：
// 按该分支自己的生效规则取必需检查（审查检查叫 review-pr (integration)），分支头 CI 成功，GitHub 要求同步时追该分支，合并后核对父提交。
// 只在 GitHub 要求先同步时追目标分支（#26，2026-11-07 用户定）：mergeStateStatus=CLEAN 就直接合，落后也不追；
// 只有开了 strict 的分支上 PR 落后、状态是 BEHIND 时才 update-branch，等新 head 上的必需检查重新通过再合
// （集成分支原来开着 strict，2026-11-12 用户定关掉，现在 main 和集成分支都没开）。
// 已知代价（用户已接受）：Mivo main 没开 strict，PR 和 main 新改动的组合问题要合并后 main CI 才发现（Mivo #1551）；
// 兜底是合并后 main CI 不成功就暂停车道、父提交对不上就冻结。
// 目标分支头上的全部检查都绿才合或追分支（#32，2026-11-08 用户定）：只看 ci.yml 时，main 上 CodeQL 红着照样合了 #1997。
// 「全部检查」只算这个提交被 push 时跑出来的（#36）：别的 PR 的审查、定时任务、评论触发的工作流也把检查挂在 main 头提交上，跟 main 本身无关。
// GitHub 的合并接口锁不住 base：检查到合并之间目标分支若被别人推进，合入的组合就和检查时不同。
// 这个窗口关不死（对 App 单开 strict 会让别人被拦下的 PR 显示 BEHIND，审查机当成状态变化反复重审，2026-11-06 试过已撤）。
// 所以本轮钉住 CI 已成功的那个分支头提交，BEHIND 时的落后判断对着它比；合并后核对父提交是不是它，不是就冻结车道。
// 依赖顺序由 tick 保证（依赖没 merged 就不会走到这里），所以有依赖的 PR 要等前一个真正合进去才处理。
import { MIVO_INTEGRATION_MERGE_METHOD, MIVO_INTEGRATION_REVIEW_CHECK, toAuthorMismatch } from '../policy.mjs'
import { toLabelActorVerdict, toLabelMissing } from '../auto-intake.mjs'
import { toRequiredChecksVerdict } from '../mivo-required.mjs'
import { GitHubError } from '../github.mjs'
import { toBranchCiState, toMainRedEvents, toRedFailures, watchIntegrationBranches } from '../ci-watch.mjs'

const PR_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$branch:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){id mergeStateStatus mergeQueueEntry{state}} mergeQueue(branch:$branch){id}}}'
const ENQUEUE = 'mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{id state}}}'
const MAIN = 'main'
// 分支头检查算绿的结论；不绿的检查在原因里最多列这么多个
const GREEN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const MAX_LISTED_CHECKS = 10
const ACTIONS_APP_SLUG = 'github-actions'
// CodeQL 默认配置的 workflow run 的 event 是 dynamic，push 和定时只能看名字分：push 触发的叫「Push on <分支>」，
// Code Quality 的带「Code Quality: 」前缀；定时的叫「Scheduled」（2026-11-08 在 Mivo 最近 1000 个 dynamic run 上核实）
const DYNAMIC_PUSH_NAME = /(?:^|: )Push on /

export default {
  id: 'mivo',

  // 每轮先看车道级条件：规则集没被改松（改松就冻结）；main 当前 head 的 CI 成功、且这个提交上的全部检查都绿（不满足只暂停，不冻结）。
  // 只认 main 当前 head 的 run：刚合进去的提交 CI 还没出结论时，旧提交的 success 不算数。
  // 先看 ci.yml 再看全部检查：CI 跑着的十几分钟里原因保持 main_ci_not_success 不变，不因检查陆续完成反复叫醒伙伴。
  // 转全绿的那一轮就发 lane_resumed 并接着处理队列。
  // 集成分支的这几项在处理到它的 PR 时按分支各查一次，见 toIntegrationTarget。
  // CI 红灯监视（#48）：先看在用的集成分支（main 暂停时也照看），main 真红时另发 main_ci_red；判定见 src/ci-watch.mjs
  async beforeItems({ repo, laneState, client, repoPolicy, openPrs }) {
    delete laneState.checkedBaseShas
    const watched = await watchIntegrationBranches({ repo, client, laneState, toCheckVerdict, openPrs })
    const required = await toRequiredChecksVerdict({ client, repo, repoPolicy, branch: MAIN })
    if (!required.ok) {
      laneState.frozen = { reason: required.reason, at: new Date().toISOString() }
      return { stopLane: true, events: [...watched, { type: 'lane_frozen', repo, reason: required.reason }] }
    }
    const pause = (reason, red = []) => {
      const events = laneState.paused === reason ? [] : [{ type: 'lane_paused', repo, reason }]
      laneState.paused = reason
      return { stopLane: true, events: [...watched, ...events, ...red] }
    }
    const mainSha = (await client.request('GET', `/repos/${repo}/branches/${MAIN}`)).commit.sha
    const runs = await client.request('GET', `/repos/${repo}/actions/workflows/ci.yml/runs?branch=${MAIN}&event=push&head_sha=${mainSha}&per_page=1`)
    const latest = runs.workflow_runs?.[0]
    if (!latest || latest.conclusion !== 'success') {
      const ci = await toBranchCiState({ client, repo, branch: MAIN, sha: mainSha, toCheckVerdict, ciRun: latest ?? null })
      return pause(`main_ci_not_success: ${mainSha.slice(0, 8)} ${latest ? `${latest.status}/${latest.conclusion}` : 'no_run'}`, toMainRedEvents({ repo, laneState, sha: mainSha, ci }))
    }
    const verdict = await toCheckVerdict({ client, repo, sha: mainSha })
    const notGreen = toNotGreenText(verdict)
    if (notGreen) {
      const failures = toRedFailures(verdict)
      const ci = failures.length && !verdict.readError ? { state: 'red', detail: toListText([...failures].sort()) } : { state: 'pending' }
      return pause(`main_checks_not_green: ${mainSha.slice(0, 8)} ${notGreen}`, toMainRedEvents({ repo, laneState, sha: mainSha, ci }))
    }
    toMainRedEvents({ repo, laneState, sha: mainSha, ci: { state: 'green' } })
    const events = laneState.paused ? [{ type: 'lane_resumed', repo }] : []
    delete laneState.paused
    laneState.checkedMainSha = mainSha
    return { events: [...watched, ...events] }
  },

  async process({ item, repoPolicy, laneState, client, facts, shadow }) {
    const pr = await facts.pr()
    // 别人合进去也会让目标分支前进：本轮停下，下一轮按新分支头的 CI 重判，不拿旧的分支头去合下一个
    if (pr.merged) return { status: 'merged', stopLane: true, reason: item.queueState === 'enqueued' ? 'merged_by_queue' : 'merged_elsewhere', events: [{ type: 'merged', repo: item.repo, pr: item.number, head: pr.head.sha }] }
    if (pr.state !== 'open') return { status: 'closed', reason: `pr_${pr.state}` }
    const head = pr.head.sha
    if (!item.seenHeads.includes(head)) item.seenHeads.push(head)
    // 授权时的目标分支；#20 之前入队的条目没有记录，那时只收 main
    const base = item.base ?? MAIN
    // 授权后 PR 被改到别的分支：不按新分支去查规则（新分支可能根本不在规则集里），直接不合
    if (base !== MAIN && pr.base.ref !== base) return { reason: `base: 期望 ${base}，实际 ${pr.base.ref}` }

    const [owner, name] = item.repo.split('/')
    const { pullRequest: gql, mergeQueue } = (await client.graphql(PR_QUERY, { owner, name, number: item.number, branch: base })).repository

    if (item.queueState === 'enqueued') {
      if (gql.mergeQueueEntry) return { reason: `in_merge_queue: ${gql.mergeQueueEntry.state}` }
      return { status: 'dequeued', reason: '被移出合并队列且未合入（组合 CI 失败或被人移出），不自动重新入队', events: [{ type: 'dequeued', repo: item.repo, pr: item.number, head }] }
    }

    // main 用 beforeItems 里 CI 已确认成功的那个提交，不再另读（另读可能是 CI 还没出结论的新提交）
    const target = base === MAIN
      ? { policy: repoPolicy, sha: laneState.checkedMainSha }
      : await toIntegrationTarget({ repo: item.repo, branch: base, repoPolicy, laneState, client })
    if (target.frozen) {
      laneState.frozen = { reason: target.frozen, at: new Date().toISOString() }
      return { stopLane: true, reason: target.frozen, events: [{ type: 'lane_frozen', repo: item.repo, reason: target.frozen }] }
    }
    if (target.hold) return { reason: target.hold }

    const actor = await toAutoIntakeActorVerdict(item, pr, facts)
    // 读不到标签操作者记在条目上，本轮最后和接单出错一起决定叫不叫醒伙伴（见 auto-intake.mjs settleAutoIntakeErrors）
    if (actor?.readFailed) item.autoIntakeReadError = actor.reason
    else delete item.autoIntakeReadError
    const failures = await toMivoFailures({ item, pr, gql, base, repoPolicy: target.policy, facts, actor })
    if (failures.length) return { reason: failures.join(' | ') }

    if (mergeQueue) return toEnqueue({ item, gql, head, client, shadow })

    const baseSha = target.sha
    if (!baseSha) return { stopLane: true, reason: 'main_not_checked: 本轮没有确认 main 的 CI，跳过' }
    // GitHub 判定能直接合（CLEAN）就直接合，不因落后目标分支先追：落后但 GitHub 不要求同步时，追分支只会让 CI 和审查机白跑一遍
    if (gql.mergeStateStatus === 'CLEAN') return toDirectMerge({ item, head, base, baseSha, mergeMethod: target.policy.mergeMethod, laneState, client, shadow })
    // 走到这里只剩 BEHIND（门禁只放行 CLEAN 和 BEHIND）：开了 strict 的分支要求先同步。对着钉住的分支头比落后数
    const behind = await facts.behindBy(baseSha, head)
    if (behind > 0) return toUpdateBranch({ item, head, base, behind, client, shadow })
    // BEHIND 但对钉住的提交不落后，说明分支在本轮检查后又前进了，下一轮重判。
    // 只有 main 的钉住提交是整条车道共用的，所以只有 main 前进才停整条车道
    return { stopLane: base === MAIN, reason: `merge_state: BEHIND（${base} 已越过本轮检查的 ${baseSha.slice(0, 8)}），下一轮重判` }
  },
}

// helpers

// 集成分支：按这个分支自己的生效规则比对必需检查（改松就冻结车道，和 main 一样），分支头 CI 不成功、或分支头上的检查不全绿（和 main 同一条规则），就留在队列。
// 集成分支不绿只挡合进它的 PR，不暂停整条车道：main 的 PR 照常合。
// 钉住的分支头按分支分开记在 laneState.checkedBaseShas，一个分支前进不影响别的分支。
async function toIntegrationTarget({ repo, branch, repoPolicy, laneState, client }) {
  const requiredChecks = [...repoPolicy.requiredChecks.filter((context) => context !== 'review-pr'), MIVO_INTEGRATION_REVIEW_CHECK]
  const policy = { ...repoPolicy, requiredChecks, mergeMethod: MIVO_INTEGRATION_MERGE_METHOD }
  const rules = await toRequiredChecksVerdict({ client, repo, repoPolicy: policy, branch })
  if (!rules.ok) return { frozen: `${rules.reason}（${branch}）` }
  let sha
  try {
    sha = (await client.request('GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`)).commit.sha
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return { hold: `base_branch_missing: ${branch} 不存在` }
    throw err
  }
  const runs = await client.request('GET', `/repos/${repo}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&event=push&head_sha=${sha}&per_page=1`)
  const latest = runs.workflow_runs?.[0]
  if (!latest || latest.conclusion !== 'success') return { hold: `base_ci_not_success: ${branch} ${sha.slice(0, 8)} ${latest ? `${latest.status}/${latest.conclusion}` : 'no_run'}` }
  const notGreen = await toNotGreenChecks({ client, repo, sha })
  if (notGreen) return { hold: `base_checks_not_green: ${branch} ${sha.slice(0, 8)} ${notGreen}` }
  laneState.checkedBaseShas = { ...laneState.checkedBaseShas, [branch]: sha }
  return { policy, sha }
}

// 分支头提交上不绿的检查，全绿返回 null。
// 只算 push 触发的检查（#36）：GitHub Actions 的 check run 按所属 check suite 找到 workflow run，event 是 push 才算，
// dynamic（CodeQL 默认配置）只算名字是「Push on …」的；workflow_dispatch / schedule / issue_comment / workflow_run 等都不算。
// 别的 App 写的 check run 照旧都算。找不到所属 workflow run 的 Actions check run 不知道来源，按不绿处理。
// 先按来源筛再取最新：定时重跑的同名 CodeQL 比 push 那次新，先取最新会把 push 那次的结果丢掉。
// 筛完按（写入的 App，名字）分组取最新一次（id 最大），必须 completed 且结论是 success / skipped / neutral；
// 同名检查可能来自不同 App，只按名字取会让别的 App 较新的成功盖掉这个 App 的失败。
// commit status 有条目时合并状态必须是 success（没有条目时 GitHub 给的合并状态是 pending，不算不绿）；一个算数的 check run 都没有也不算绿。
// 读取失败或分页读不全按不绿处理，不拿读到的部分当全部。失败的排在未完成的前面，各自按名字排序，原因不随接口返回顺序变
async function toNotGreenChecks({ client, repo, sha }) {
  return toNotGreenText(await toCheckVerdict({ client, repo, sha }))
}

// 上面判断的结构化结果（#48 CI 红灯监视要分清真失败和还没出结论）：
// failed 已结束且不算绿的检查、失败的 commit status；unfinished 还在跑的；unknown 来源未知的、合并状态说不清的；
// readError 读取失败或读不全；empty 一个算数的 check run 都没有
async function toCheckVerdict({ client, repo, sha }) {
  const verdict = { failed: [], unfinished: [], unknown: [], readError: null, empty: false }
  let checkRuns
  let workflowRuns
  let combined
  try {
    checkRuns = await readAllPages(client, `/repos/${repo}/commits/${sha}/check-runs`, 'check_runs')
    if (checkRuns.missing) return { ...verdict, readError: `check run 读不全：${checkRuns.missing}` }
    workflowRuns = await readAllPages(client, `/repos/${repo}/actions/runs?head_sha=${sha}&exclude_pull_requests=true`, 'workflow_runs')
    if (workflowRuns.missing) return { ...verdict, readError: `workflow run 读不全：${workflowRuns.missing}` }
    combined = await client.request('GET', `/repos/${repo}/commits/${sha}/status?per_page=100`)
  } catch (err) {
    return { ...verdict, readError: `检查读取失败（${err.message}）` }
  }
  const bySuite = new Map(workflowRuns.items.map((wr) => [wr.check_suite_id, wr]))
  const latest = new Map()
  const unknown = new Set()
  for (const run of checkRuns.items) {
    if (run.app?.slug === ACTIONS_APP_SLUG) {
      const wr = bySuite.get(run.check_suite?.id)
      if (!wr) {
        unknown.add(`${run.name}=来源未知（check suite ${run.check_suite?.id ?? 'none'} 没有对应的 workflow run）`)
        continue
      }
      if (!isPushTriggered(wr)) continue
    }
    const key = `${run.app?.id ?? 'none'}\u0000${run.name}`
    if (!(latest.get(key)?.id > run.id)) latest.set(key, run)
  }
  verdict.unknown.push(...unknown)
  // 一个算数的 check run 都没有：暂停原因照旧写 no_check_runs；commit status 仍要看，明确失败时 CI 红灯监视要报
  verdict.empty = latest.size === 0 && unknown.size === 0
  for (const run of latest.values()) {
    if (run.status !== 'completed') verdict.unfinished.push(`${run.name}=${run.status}`)
    else if (!GREEN_CONCLUSIONS.has(run.conclusion)) verdict.failed.push(`${run.name}=${run.conclusion}`)
  }
  if ((combined.total_count ?? 0) > 0 && combined.state !== 'success') {
    const bad = (combined.statuses ?? []).filter((st) => st.state !== 'success')
    // 明细里没有不成功的条目（超过 100 条、失败项在后面的页）：聚合状态是 failure / error 就算失败，pending 说不清
    if (bad.length === 0) (['failure', 'error'].includes(combined.state) ? verdict.failed : verdict.unknown).push(`commit_status=${combined.state}`)
    for (const st of bad) (st.state === 'pending' ? verdict.unfinished : verdict.failed).push(`${st.context}=${st.state}`)
    // 看得见的不成功条目都是 pending、聚合却是 failure / error：失败项在后面的页。只给 CI 红灯监视用（hiddenFailed），暂停原因文字不变
    if (bad.length > 0 && bad.every((st) => st.state === 'pending') && ['failure', 'error'].includes(combined.state)) verdict.hiddenFailed = [`commit_status=${combined.state}`]
  }
  return verdict
}

// 结构化结果 → 暂停原因里的文字（来源未知、合并状态说不清的和失败的排在一起，与拆分前一致）；全绿返回 null
function toNotGreenText(verdict) {
  if (verdict.readError) return verdict.readError
  if (verdict.empty) return 'no_check_runs: 还没有任何 push 触发的 check run'
  const all = [...[...verdict.unknown, ...verdict.failed].sort(), ...[...verdict.unfinished].sort()]
  return all.length === 0 ? null : toListText(all)
}

const toListText = (all) => (all.length > MAX_LISTED_CHECKS ? `${all.slice(0, MAX_LISTED_CHECKS).join(', ')} 等 ${all.length} 项` : all.join(', '))

const isPushTriggered = (wr) => wr.event === 'push' || (wr.event === 'dynamic' && DYNAMIC_PUSH_NAME.test(wr.name ?? ''))

// 按 total_count 读完全部分页（每页 100，最多 10 页）；读不全时 missing 写明共几个、读到几个
async function readAllPages(client, path, field) {
  const items = []
  let total = 0
  for (let page = 1; page <= 10; page++) {
    const data = await client.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const batch = data[field] ?? []
    items.push(...batch)
    total = data.total_count ?? items.length
    if (batch.length < 100 || items.length >= total) break
  }
  return { items, missing: items.length < total ? `共 ${total} 个，只读到 ${items.length} 个` : null }
}

// 写请求之前不走 facts 缓存重读 PR：从快照到写之间（要读规则、分支头、CI、检查），PR 可能被改到别的分支或换了 head，
// 而合并接口只锁 head（sha）、update-branch 只锁 expected_head_sha，都锁不住目标分支。影子模式也先复核，判断和真合并一致。
// 重读到写请求之间仍有极短窗口，GitHub 没有锁 base 的参数，关不死。
async function readPrChangeBeforeWrite({ item, base, head, client }) {
  const pr = await client.request('GET', `/repos/${item.repo}/pulls/${item.number}`)
  const changes = []
  if (pr.state !== 'open') changes.push(`state 期望 open，实际 ${pr.state}`)
  // 门禁拒绝 Draft，复核也拒绝：merge 接口会拒 Draft，update-branch 不会，会改写作者已暂停的 PR
  if (pr.draft === true) changes.push('draft 期望 false，实际 true')
  if (pr.base?.ref !== base) changes.push(`base 期望 ${base}，实际 ${pr.base?.ref}`)
  if (pr.head?.sha !== head) changes.push(`head 期望 ${head.slice(0, 8)}，实际 ${pr.head?.sha?.slice(0, 8)}`)
  // 自动接单的条目：门禁检查后标签被审查机摘掉，也不写
  const labelMissing = toLabelMissing(item, pr)
  if (labelMissing) changes.push(labelMissing)
  return changes.length ? `pr_changed_before_write: ${changes.join('；')}` : null
}

async function toEnqueue({ item, gql, head, client, shadow }) {
  if (shadow) {
    const events = item.shadowLoggedHead === head ? [] : [{ type: 'would_enqueue', repo: item.repo, pr: item.number, head }]
    item.shadowLoggedHead = head
    return { reason: 'shadow_would_enqueue', events }
  }
  await client.graphql(ENQUEUE, { id: gql.id, oid: head })
  item.queueState = 'enqueued'
  return { reason: 'enqueued', events: [{ type: 'enqueued', repo: item.repo, pr: item.number, head }] }
}

// 追目标分支会换 head：CI 和审查机都要在新 head 上重跑，下一轮门禁按新 head 重新判断。
// update-branch 总是并入 PR 自己的目标分支，集成分支 PR 追的是集成分支，不是 main
async function toUpdateBranch({ item, head, base, behind, client, shadow }) {
  const changed = await readPrChangeBeforeWrite({ item, base, head, client })
  if (changed) return { reason: changed }
  const reason = `up_to_date: 落后 ${base} ${behind} 个提交`
  if (shadow) {
    const events = item.shadowLoggedHead === `update:${head}` ? [] : [{ type: 'would_update_branch', repo: item.repo, pr: item.number, head }]
    item.shadowLoggedHead = `update:${head}`
    return { stopLane: true, reason: `shadow_would_update_branch | ${reason}`, events }
  }
  await client.request('PUT', `/repos/${item.repo}/pulls/${item.number}/update-branch`, { expected_head_sha: head })
  return { stopLane: true, reason: `update_branch_requested | ${reason}`, events: [{ type: 'update_branch', repo: item.repo, pr: item.number, head }] }
}

async function toDirectMerge({ item, head, base, baseSha, mergeMethod, laneState, client, shadow }) {
  const changed = await readPrChangeBeforeWrite({ item, base, head, client })
  if (changed) return { reason: changed }
  if (shadow) {
    const events = item.shadowLoggedHead === head ? [] : [{ type: 'would_merge', repo: item.repo, pr: item.number, head }]
    item.shadowLoggedHead = head
    return { stopLane: true, reason: 'shadow_would_merge', events }
  }
  let res
  try {
    res = await client.request('PUT', `/repos/${item.repo}/pulls/${item.number}/merge`, { sha: head, merge_method: mergeMethod })
  } catch (err) {
    if (err instanceof GitHubError && [405, 409, 422].includes(err.status)) {
      return { stopLane: true, reason: `merge_refused: ${err.message}`, events: [{ type: 'merge_refused', repo: item.repo, pr: item.number, reason: err.message }] }
    }
    // 网络错误或 5xx：GitHub 那边可能已经合了。下一轮会把它当成别人合的、跳过核对，所以这里直接冻结等人看
    const reason = `merge_result_unknown: #${item.number} 合并请求没拿到明确结果（${err.message}），可能已合入；看过 PR 和 ${base} CI 再 unfreeze`
    laneState.frozen = { reason, at: new Date().toISOString() }
    return { stopLane: true, reason, events: [{ type: 'lane_frozen', repo: item.repo, reason }] }
  }
  const events = [{ type: 'merged', repo: item.repo, pr: item.number, head, mergeSha: res.sha }]
  const freeze = (reason) => {
    laneState.frozen = { reason, at: new Date().toISOString() }
    events.push({ type: 'lane_frozen', repo: item.repo, reason })
  }
  // 已经合进去了：核对失败也不能抛错（抛了这条就记不成 merged，下一轮会当成别人合的，核对就丢了）
  let parents
  try {
    parents = (await client.request('GET', `/repos/${item.repo}/commits/${res.sha}`)).parents ?? []
  } catch (err) {
    freeze(`merge_parent_unverified: #${item.number} 已合入 ${res.sha.slice(0, 8)}，但读不到合并提交（${err.message}），无法确认组合测过；看过 ${base} CI 再 unfreeze`)
    return { status: 'merged', reason: `merged ${res.sha}`, stopLane: true, events }
  }
  // squash / rebase 的合并提交只有一个父提交（检查时的分支头）；merge 的是两个：检查时的分支头 + 锁定的 head
  const expected = mergeMethod === 'merge' ? [baseSha, head] : [baseSha]
  if (parents.length !== expected.length || parents.some((p, i) => p.sha !== expected[i])) {
    const actual = parents.map((p) => p.sha.slice(0, 8)).join(',') || 'none'
    freeze(`merged_on_moved_${base === MAIN ? 'main' : 'base'}: #${item.number} 合并时 ${base} 已不是检查时的 ${baseSha.slice(0, 8)}（合并提交的父提交 ${actual}），这个组合没测过；${base} CI 通过后再 unfreeze`)
  }
  return { status: 'merged', reason: `merged ${res.sha}`, stopLane: true, events }
}

// 自动接单的条目、标签还在时，核对标签最近一次的操作者；其余情况返回 null（不读 events）
async function toAutoIntakeActorVerdict(item, pr, facts) {
  if (!item.autoIntakeLabel || toLabelMissing(item, pr)) return null
  return toLabelActorVerdict({ facts, label: item.autoIntakeLabel, actors: item.autoIntakeLabelActors })
}

async function toMivoFailures({ item, pr, gql, base, repoPolicy, facts, actor }) {
  const failures = []
  const authorMismatch = toAuthorMismatch('mivo', pr.user?.login)
  if (authorMismatch) failures.push(`author: ${authorMismatch}`)
  // 自动接单的条目还要 PR 当前仍带接单时的标签，且标签最近一次是名单里的账号挂的；原有门禁一条不少
  const labelMissing = toLabelMissing(item, pr)
  if (labelMissing) failures.push(labelMissing)
  if (actor && !actor.ok) failures.push(actor.reason)
  if (pr.draft) failures.push('not_draft: draft')
  if (pr.base.ref !== base) failures.push(`base: 期望 ${base}，实际 ${pr.base.ref}`)
  const states = await facts.checkStates(pr.head.sha)
  const bad = repoPolicy.requiredChecks.flatMap((context) => {
    const s = states.get(context)
    if (!s?.passed) return [`${context}=${s?.state ?? 'missing'}`]
    if (repoPolicy.integrationId !== null && (s.kind !== 'check' || s.appId !== repoPolicy.integrationId)) return [`${context}: 写入方不是 integration ${repoPolicy.integrationId}`]
    return []
  })
  if (bad.length) failures.push(`required_checks: ${bad.join(', ')}`)
  const open = await facts.unresolvedThreads()
  if (open > 0) failures.push(`threads_resolved: 未解决讨论 ${open} 条`)
  // mergeStateStatus 按调用者计算，这里是 App 自己看到的值
  // BEHIND 留给后面追目标分支（开了 strict 的分支上，落后的 PR 是 BEHIND 而不是 CLEAN）
  if (!['CLEAN', 'BEHIND'].includes(gql.mergeStateStatus)) failures.push(`merge_state: ${gql.mergeStateStatus}`)
  return failures
}
