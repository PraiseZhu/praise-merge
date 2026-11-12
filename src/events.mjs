// 哪些事件要叫醒合并伙伴（进而通知用户）。影子记录（would_*）只进日志，不叫醒。
// merge_order_invalid / merge_order_blocked（#38）：本人 PR 正文「合并顺序」无效没接单 / 依赖关闭未合入或读不到，要人看
// auto_intake：自动接了一个 bot PR（每个 PR 每次接单一条）；auto_intake_failed / auto_intake_recovered：自动接单出错开始（或原因变了）/ 恢复
// main_ci_red / integration_ci_red（#48）：main 或在用的集成分支当前提交 CI 变红，伙伴要用飞书通知用户；integration_ci_recovered：集成分支转绿
// ci_watch_failed（#48）：CI 红灯监视读 GitHub 失败，只进日志，不在这里
export const WAKE_TYPES = new Set([
  'auto_intake', 'auto_intake_failed', 'auto_intake_recovered', 'merged', 'enqueued', 'dequeued', 'expired', 'rejected', 'closed', 'blocked_by_dependency',
  'merge_refused', 'merge_order_invalid', 'merge_order_blocked', 'lane_frozen', 'lane_paused', 'lane_resumed', 'health_alert', 'request_rejected',
  'main_ci_red', 'integration_ci_red', 'integration_ci_recovered',
])

// 每个要叫醒的事件一行 JSON，只带 type、repo、pr、branch、reason / head；没有就返回空数组。
// 车道事件和状态变化可能对同一 PR 各报一次同类事件（如 merged），按 type+repo+pr+branch 只留第一条
// （branch 区分同一轮里不同分支的 CI 红灯，#48；没有 branch 的事件和以前一样）。
export function toEventLines(events = []) {
  const seen = new Set()
  return events
    .filter((ev) => WAKE_TYPES.has(ev.type))
    .filter((ev) => {
      const key = `${ev.type}|${ev.repo ?? ''}|${ev.pr ?? ''}|${ev.branch ?? ''}|${ev.repo || ev.pr ? '' : ev.reason}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(({ type, repo = null, pr = null, branch = null, reason = null, head = null }) => JSON.stringify({ type, repo, pr, ...(branch ? { branch } : {}), ...(reason ? { reason } : {}), ...(head ? { head } : {}) }))
}
