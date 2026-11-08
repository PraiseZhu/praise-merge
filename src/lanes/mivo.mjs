// Mivo 车道：门禁全过后，目标分支开着合并队列就用 App 入队（组合测试和合并由队列完成）；
// 没开队列就由 App 直接合并（锁定检查过的 head）。
// 目标分支只有 main 和 integration/*（接单时已拒收其他分支）。集成分支的门槛不低于 main：
// 按该分支自己的生效规则取必需检查（审查检查叫 review-pr (integration)），分支头 CI 成功，GitHub 要求同步时追该分支，合并后核对父提交。
// 只在 GitHub 要求先同步时追目标分支（#26，2026-11-07 用户定）：mergeStateStatus=CLEAN 就直接合，落后也不追；
// 只有开了 strict 的分支（集成分支就开了）上 PR 落后、状态是 BEHIND 时才 update-branch，等新 head 上的必需检查重新通过再合。
// 已知代价（用户已接受）：Mivo main 没开 strict，PR 和 main 新改动的组合问题要合并后 main CI 才发现（Mivo #1551）；
// 兜底是合并后 main CI 不成功就暂停车道、父提交对不上就冻结。
// 目标分支头上的全部检查都绿才合或追分支（#32，2026-11-08 用户定）：只看 ci.yml 时，main 上 CodeQL 红着照样合了 #1997。
// GitHub 的合并接口锁不住 base：检查到合并之间目标分支若被别人推进，合入的组合就和检查时不同。
// 这个窗口关不死（对 App 单开 strict 会让别人被拦下的 PR 显示 BEHIND，审查机当成状态变化反复重审，2026-11-06 试过已撤）。
// 所以本轮钉住 CI 已成功的那个分支头提交，BEHIND 时的落后判断对着它比；合并后核对父提交是不是它，不是就冻结车道。
// 依赖顺序由 tick 保证（依赖没 merged 就不会走到这里），所以有依赖的 PR 要等前一个真正合进去才处理。
import { MIVO_INTEGRATION_MERGE_METHOD, MIVO_INTEGRATION_REVIEW_CHECK, toAuthorMismatch } from '../policy.mjs'
import { toLabelActorVerdict, toLabelMissing } from '../auto-intake.mjs'
import { toRequiredChecksVerdict } from '../mivo-required.mjs'
import { GitHubError } from '../github.mjs'

const PR_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$branch:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){id mergeStateStatus mergeQueueEntry{state}} mergeQueue(branch:$branch){id}}}'
const ENQUEUE = 'mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{id state}}}'
const MAIN = 'main'
// 分支头检查算绿的结论；不绿的检查在原因里最多列这么多个
const GREEN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const MAX_LISTED_CHECKS = 10

export default {
  id: 'mivo',

  // 每轮先看车道级条件：规则集没被改松（改松就冻结）；main 当前 head 的 CI 成功、且这个提交上的全部检查都绿（不满足只暂停，不冻结）。
  // 只认 main 当前 head 的 run：刚合进去的提交 CI 还没出结论时，旧提交的 success 不算数。
  // 先看 ci.yml 再看全部检查：CI 跑着的十几分钟里原因保持 main_ci_not_success 不变，不因检查陆续完成反复叫醒伙伴。
  // 转全绿的那一轮就发 lane_resumed 并接着处理队列。
  // 集成分支的这几项在处理到它的 PR 时按分支各查一次，见 toIntegrationTarget。
  async beforeItems({ repo, laneState, client, repoPolicy }) {
    delete laneState.checkedBaseShas
    const required = await toRequiredChecksVerdict({ client, repo, repoPolicy, branch: MAIN })
    if (!required.ok) {
      laneState.frozen = { reason: required.reason, at: new Date().toISOString() }
      return { stopLane: true, events: [{ type: 'lane_frozen', repo, reason: required.reason }] }
    }
    const pause = (reason) => {
      const events = laneState.paused === reason ? [] : [{ type: 'lane_paused', repo, reason }]
      laneState.paused = reason
      return { stopLane: true, events }
    }
    const mainSha = (await client.request('GET', `/repos/${repo}/branches/${MAIN}`)).commit.sha
    const runs = await client.request('GET', `/repos/${repo}/actions/workflows/ci.yml/runs?branch=${MAIN}&event=push&head_sha=${mainSha}&per_page=1`)
    const latest = runs.workflow_runs?.[0]
    if (!latest || latest.conclusion !== 'success') return pause(`main_ci_not_success: ${mainSha.slice(0, 8)} ${latest ? `${latest.status}/${latest.conclusion}` : 'no_run'}`)
    const notGreen = await toNotGreenChecks({ client, repo, sha: mainSha })
    if (notGreen) return pause(`main_checks_not_green: ${mainSha.slice(0, 8)} ${notGreen}`)
    const events = laneState.paused ? [{ type: 'lane_resumed', repo }] : []
    delete laneState.paused
    laneState.checkedMainSha = mainSha
    return { events }
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

// 分支头提交上不绿的检查，全绿返回 null。check run 按（写入的 App，名字）分组取最新一次（id 最大），必须 completed 且结论是 success / skipped / neutral；
// 同名检查可能来自不同 App（如 CodeQL 默认配置和仓里的工作流），只按名字取会让别的 App 较新的成功盖掉这个 App 的失败。
// commit status 有条目时合并状态必须是 success（没有条目时 GitHub 给的合并状态是 pending，不算不绿）；一个 check run 都没有也不算绿。
// 读取失败或分页读不全按不绿处理，不拿读到的部分当全部。失败的排在未完成的前面，各自按名字排序，原因不随接口返回顺序变
async function toNotGreenChecks({ client, repo, sha }) {
  const latest = new Map()
  let combined
  try {
    let read = 0
    let total = 0
    for (let page = 1; page <= 10; page++) {
      const data = await client.request('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`)
      const batch = data.check_runs ?? []
      read += batch.length
      total = data.total_count ?? read
      for (const run of batch) {
        const key = `${run.app?.id ?? 'none'}\u0000${run.name}`
        if (!(latest.get(key)?.id > run.id)) latest.set(key, run)
      }
      if (batch.length < 100 || read >= total) break
    }
    if (read < total) return `check run 读不全：共 ${total} 个，只读到 ${read} 个`
    combined = await client.request('GET', `/repos/${repo}/commits/${sha}/status?per_page=100`)
  } catch (err) {
    return `检查读取失败（${err.message}）`
  }
  if (latest.size === 0) return 'no_check_runs: 还没有任何 check run'
  const failed = []
  const unfinished = []
  for (const run of latest.values()) {
    if (run.status !== 'completed') unfinished.push(`${run.name}=${run.status}`)
    else if (!GREEN_CONCLUSIONS.has(run.conclusion)) failed.push(`${run.name}=${run.conclusion}`)
  }
  if ((combined.total_count ?? 0) > 0 && combined.state !== 'success') {
    const bad = (combined.statuses ?? []).filter((st) => st.state !== 'success')
    if (bad.length === 0) failed.push(`commit_status=${combined.state}`)
    for (const st of bad) (st.state === 'pending' ? unfinished : failed).push(`${st.context}=${st.state}`)
  }
  const all = [...failed.sort(), ...unfinished.sort()]
  if (all.length === 0) return null
  return all.length > MAX_LISTED_CHECKS ? `${all.slice(0, MAX_LISTED_CHECKS).join(', ')} 等 ${all.length} 项` : all.join(', ')
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
