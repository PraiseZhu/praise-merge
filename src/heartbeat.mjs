// 心跳：每轮写 state/heartbeat.json（最后一轮的时间、结果、连续失败次数），并据此产生健康告警。
// 两种告警：距上一轮超过 10 分钟（调度停过、机器睡过）；连续 3 轮失败。
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const GAP_MS = 10 * 60_000
export const MAX_FAILURES = 3

export function readHeartbeat(stateDir) {
  const file = join(stateDir, 'heartbeat.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

// 写本轮心跳，返回 { heartbeat, alerts }
export function recordRound(stateDir, { ok, error = null }, now = Date.now()) {
  const prev = readHeartbeat(stateDir)
  const heartbeat = {
    lastRunAt: new Date(now).toISOString(),
    lastResult: ok ? 'ok' : 'error',
    lastError: ok ? null : String(error).slice(0, 300),
    consecutiveFailures: ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
  }
  const file = join(stateDir, 'heartbeat.json')
  writeFileSync(`${file}.tmp-${process.pid}`, `${JSON.stringify(heartbeat, null, 2)}\n`)
  renameSync(`${file}.tmp-${process.pid}`, file)

  const alerts = []
  if (prev && now - Date.parse(prev.lastRunAt) > GAP_MS) {
    alerts.push({ type: 'health_alert', reason: `heartbeat_gap: 距上一轮 ${Math.round((now - Date.parse(prev.lastRunAt)) / 60_000)} 分钟` })
  }
  if (heartbeat.consecutiveFailures >= MAX_FAILURES) {
    alerts.push({ type: 'health_alert', reason: `consecutive_failures: 连续 ${heartbeat.consecutiveFailures} 轮失败，最近一次：${heartbeat.lastError}` })
  }
  return { heartbeat, alerts }
}
