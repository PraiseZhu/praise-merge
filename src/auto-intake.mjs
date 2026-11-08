// 自动接单（用户 2026-11-08 定：praise-qa bot 的 Mivo PR 满足标准自动合，不用用户说「合并」）。
// policy 条目带 auto_intake 时，每轮处理队列前用 App 令牌只读列一次这个仓 open 的 PR，把符合条件的接进队列。
// 标签必须是 label_actors 里的账号挂的（按 issue events 里这个标签最近一次 labeled 事件的操作者核对）：
// 只有 Triage 权限的人补挂标签不能触发 App 合并（审查机推翻卡点时会写绿 review-pr 但故意不挂标签，要人工看）。
// 接进来的条目照常走车道门禁；车道另外要求 PR 处理时仍带标签、操作者仍在名单（见 lanes/mivo.mjs）。
// 车道冻结时不列也不接：冻结的车道要人看过再 unfreeze，这期间对这个仓不发任何请求。
// 接单出错（列表请求失败、读不到标签操作者）不中断本轮：照常处理已有队列，本轮最后统一记事件（settleAutoIntakeErrors）。
import { FINAL_STATUSES } from './queue.mjs'
import { toPrId } from './request.mjs'
import { createFacts } from './facts.mjs'
import { toMergeOrder } from './merge-order.mjs'

export const AUTO_INTAKE_SESSION = 'auto-intake'
export const AUTO_INTAKE_TEXT = '2026-11-08 用户定：praise-qa bot 的 Mivo PR 满足标准自动合'
export const ORDER_INTAKE_TEXT = '2026-11-08 用户定：本人 Mivo PR 按正文「合并顺序」自动合'
const PER_PAGE = 100

export const hasLabel = (pr, label) => (pr.labels ?? []).some((l) => l.name === label)

// 自动接单的条目，PR 上的标签被摘掉就不合（审查机摘标签表示不再放行），返回原因；不是自动接单的条目或标签还在返回 null
export function toLabelMissing(item, pr) {
  if (!item.autoIntakeLabel || hasLabel(pr, item.autoIntakeLabel)) return null
  return `auto_intake_label_missing: 期望标签 ${item.autoIntakeLabel}，PR 上没有`
}

// 标签最近一次 labeled 事件的操作者在不在名单里。读不到（请求失败、分页没读完）、没有 labeled 事件、不在名单都按不满足：
// 返回 { ok: false, reason, readFailed }，readFailed 表示是读失败而不是操作者不对
export async function toLabelActorVerdict({ facts, label, actors }) {
  if (!Array.isArray(actors) || actors.length === 0) return { ok: false, reason: 'auto_intake_label_actor: 条目没有记录 label_actors', readFailed: false }
  let latest
  try {
    latest = await facts.labelActor(label)
  } catch (err) {
    return { ok: false, reason: `auto_intake_label_actor: 读不到标签 ${label} 的操作者（${err.message}）`, readFailed: true }
  }
  if (!latest) return { ok: false, reason: `auto_intake_label_actor: 没找到标签 ${label} 的 labeled 事件`, readFailed: false }
  if (!actors.includes(latest.login)) return { ok: false, reason: `auto_intake_label_actor: 标签 ${label} 最近一次由 ${latest.login} 挂上，期望 ${actors.join(' 或 ')}`, readFailed: false }
  return { ok: true }
}

// 已有条目时还接不接：未完成的、已合并或已关闭的不接；过期的接；被移出队列、被拒、依赖失败的只在 head 变了时接
function toIntakeVerdict(prev, head) {
  if (!prev) return true
  if (!FINAL_STATUSES.has(prev.status)) return false
  if (prev.status === 'merged' || prev.status === 'closed') return false
  if (prev.status === 'expired') return true
  return !(prev.seenHeads ?? []).includes(head)
}

// 改 queue.items（新增或替换条目），返回 { events, errors }。errors 按仓记本轮接单出的错（[{ pr, text }]，列表请求失败时 pr 为 null），
// 每个试过接单的仓都有一项（没出错就是空数组），本轮最后交给 settleAutoIntakeErrors。影子模式照常接单，接单事件记成 would_auto_intake，只进日志
export async function intakeAutoPrs({ queue, policy, laneStates, clientFor, shadow, now }) {
  const events = []
  const errors = {}
  for (const [repo, repoPolicy] of Object.entries(policy.repos)) {
    const rule = repoPolicy.autoIntake
    if (!rule || laneStates[repo]?.frozen) continue
    errors[repo] = await intakeRepo({ repo, rule, queue, clientFor, shadow, now, events, laneState: (laneStates[repo] ??= {}) })
  }
  return { events, errors }
}

// 本轮最后统一判断接单出错要不要叫醒伙伴：本轮接单出的错，加上队列里未完成的自动接单条目上次处理时读不到标签操作者的错
// （车道处理时记在 item.autoIntakeReadError；这一轮没轮到处理的条目保留上次的结果，不当成恢复）。
// 按 PR 号排序后拼成原因，和上一轮的原因比：开始出错或原因变了发 auto_intake_failed（叫醒），同一原因接着失败只记
// auto_intake_still_failing，恢复时发 auto_intake_recovered（叫醒）。车道冻结的仓本轮没接单也没处理，状态原样保留
export function settleAutoIntakeErrors({ queue, laneStates, errors }) {
  const byRepo = new Map(Object.entries(errors).map(([repo, list]) => [repo, [...list]]))
  // 上一轮出过错的仓也要看：policy 去掉 auto_intake 后，只剩已入队条目的错，恢复时也要报
  for (const [repo, state] of Object.entries(laneStates)) if (state.autoIntakeError && !byRepo.has(repo)) byRepo.set(repo, [])
  for (const it of queue.items) {
    if (FINAL_STATUSES.has(it.status) || !it.autoIntakeReadError) continue
    if (!byRepo.has(it.repo)) byRepo.set(it.repo, [])
    byRepo.get(it.repo).push({ pr: it.number, text: `#${it.number} ${it.autoIntakeReadError}` })
  }
  const events = []
  for (const [repo, list] of byRepo) {
    if (laneStates[repo]?.frozen) continue
    const previous = laneStates[repo]?.autoIntakeError
    if (list.length === 0) {
      if (previous) {
        events.push({ type: 'auto_intake_recovered', repo })
        delete laneStates[repo].autoIntakeError
      }
      continue
    }
    // 列表请求失败（pr 为 null）排最前，其余按 PR 号：和列表返回顺序无关
    const reason = list.sort((a, b) => (a.pr ?? -1) - (b.pr ?? -1)).map((e) => e.text).join('；')
    events.push({ type: previous === reason ? 'auto_intake_still_failing' : 'auto_intake_failed', repo, reason })
    ;(laneStates[repo] ??= {}).autoIntakeError = reason
  }
  return events
}

// helpers

// 要保留的用户依赖：上一条是用户说「合并」交来的（不是自动接单）就取它请求里的 after，上一条自动接单的沿用它保留下来的
function pinnedAfter(prev) {
  if (!prev) return []
  if (prev.sessionId !== AUTO_INTAKE_SESSION) return [...(prev.after ?? [])]
  return [...(prev.pinnedAfter ?? [])]
}

async function intakeRepo({ repo, rule, queue, clientFor, shadow, now, events, laneState }) {
  const client = clientFor(repo)
  let list
  try {
    // 一轮只发这一次列表请求，不翻页；按更新时间倒序，刚挂上标签的 PR 排在前面
    list = await client.request('GET', `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(rule.base)}&sort=updated&direction=desc&per_page=${PER_PAGE}`)
  } catch (err) {
    return [{ pr: null, text: `列表请求失败（${err.message}）` }]
  }
  if (list.length >= PER_PAGE) events.push({ type: 'auto_intake_page_full', repo, reason: `open PR 有 ${PER_PAGE} 个以上，只看了最近更新的 ${PER_PAGE} 个` })
  const errors = []
  const stamp = new Date(now).toISOString()
  // 上一轮报过的「合并顺序无效」（PR 号 → head|原因）；本轮重新收集，列表里没出现的 PR 自然清掉
  const orderNotices = laneState.orderNotices ?? {}
  const seenNotices = {}
  for (const pr of list) {
    const fits = pr.state === 'open' && !pr.draft && rule.authors.includes(pr.user?.login) && pr.base?.ref === rule.base && hasLabel(pr, rule.label)
    if (!fits) continue
    const id = toPrId(repo, pr.number)
    const head = pr.head.sha
    const prev = queue.items.find((it) => it.id === id)
    if (!toIntakeVerdict(prev, head)) continue
    // 本人 PR：正文「合并顺序」无效就不接，同一 PR 同一 head 同一原因只报一次（记在车道状态里）
    const needsOrder = (rule.orderLineAuthors ?? []).includes(pr.user?.login)
    let order = null
    if (needsOrder) {
      order = toMergeOrder(pr.body, repo, pr.number)
      if (!order.ok) {
        const notice = `${head}|${order.reason}`
        if (orderNotices[pr.number] !== notice) events.push({ type: 'merge_order_invalid', repo, pr: pr.number, reason: order.reason })
        seenNotices[pr.number] = notice
        continue
      }
    }
    // 其余条件都过了才读 events，每轮只为这些 PR 各读一次
    const actor = await toLabelActorVerdict({ facts: createFacts({ client, repo, number: pr.number }), label: rule.label, actors: rule.labelActors })
    if (!actor.ok) {
      if (actor.readFailed) errors.push({ pr: pr.number, text: `#${pr.number} ${actor.reason}` })
      else events.push({ type: 'auto_intake_skipped', repo, pr: pr.number, reason: actor.reason })
      continue
    }
    const item = {
      id,
      repo,
      number: pr.number,
      base: rule.base,
      status: 'queued',
      reason: 'queued',
      // bot PR 没有正文顺序：重接单替换用户条目时沿用请求里的依赖（照旧要在队列里找到并合入）
      after: order?.after ?? pinnedAfter(prev),
      authorizedAt: stamp,
      authorizationText: needsOrder ? ORDER_INTAKE_TEXT : AUTO_INTAKE_TEXT,
      sessionId: AUTO_INTAKE_SESSION,
      sessionTitle: null,
      headShaAtAuth: head,
      seenHeads: [...new Set([...(prev?.seenHeads ?? []), head])],
      autoIntakeLabel: rule.label,
      autoIntakeLabelActors: [...rule.labelActors],
      ...(needsOrder ? { orderFromBody: true } : {}),
      // 重接单替换的是用户说「合并」交来的条目时，保留请求里的依赖：正文写「无」也不能清掉用户指定的顺序
      ...(needsOrder && pinnedAfter(prev).length ? { pinnedAfter: pinnedAfter(prev) } : {}),
      enqueuedAt: prev?.enqueuedAt ?? stamp,
      updatedAt: stamp,
    }
    if (prev) queue.items[queue.items.indexOf(prev)] = item
    else queue.items.push(item)
    events.push({ type: shadow ? 'would_auto_intake' : 'auto_intake', repo, pr: pr.number, head, ...(prev ? { reason: `重新接单（上次 ${prev.status}）` } : {}) })
  }
  if (Object.keys(seenNotices).length) laneState.orderNotices = seenNotices
  else delete laneState.orderNotices
  return errors
}
