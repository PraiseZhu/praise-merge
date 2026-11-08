// 哪些事件要叫醒合并伙伴（进而通知用户）。影子记录（would_*）只进日志，不叫醒。
// auto_intake：自动接了一个 bot PR（每个 PR 每次接单一条）
export const WAKE_TYPES = new Set([
  'auto_intake', 'merged', 'enqueued', 'dequeued', 'expired', 'rejected', 'closed', 'blocked_by_dependency',
  'merge_refused', 'lane_frozen', 'lane_paused', 'lane_resumed', 'health_alert', 'request_rejected',
])

// 每个要叫醒的事件一行 JSON，只带 type、repo、pr、reason / head；没有就返回空数组。
// 车道事件和状态变化可能对同一 PR 各报一次同类事件（如 merged），按 type+repo+pr 只留第一条。
export function toEventLines(events = []) {
  const seen = new Set()
  return events
    .filter((ev) => WAKE_TYPES.has(ev.type))
    .filter((ev) => {
      const key = `${ev.type}|${ev.repo ?? ''}|${ev.pr ?? ''}|${ev.repo || ev.pr ? '' : ev.reason}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(({ type, repo = null, pr = null, reason = null, head = null }) => JSON.stringify({ type, repo, pr, ...(reason ? { reason } : {}), ...(head ? { head } : {}) }))
}
