// 一轮：停止开关 → 加锁 → 自动接单 → 逐仓（每仓一条串行车道）处理队列条目 → 落盘 → 返回事件。
// 公共前置检查在这里做：授权过期、依赖、车道冻结。仓内具体怎么合由车道决定。
import { AUTH_TTL_MS, selectRepoPolicy } from './policy.mjs'
import { FINAL_STATUSES } from './queue.mjs'
import { createFacts } from './facts.mjs'
import { intakeAutoPrs, settleAutoIntakeErrors } from './auto-intake.mjs'

export async function runTick({ store, policy, gates, lanes, clientFor, shadow, now = Date.now() }) {
  if (store.isDisabled()) {
    store.appendLog({ type: 'disabled' }, now)
    return { disabled: true, events: [] }
  }
  const release = store.acquireLock()
  if (!release) return { locked: true, events: [] }
  try {
    const queue = store.loadQueue()
    const laneStates = store.loadLanes()
    const events = []
    const emit = (list = []) => {
      for (const ev of list) {
        events.push(ev)
        store.appendLog(ev, now)
      }
    }
    const intake = await intakeAutoPrs({ queue, policy, laneStates, clientFor, shadow, now })
    emit(intake.events)
    const byId = new Map(queue.items.map((it) => [it.id, it]))
    const setStatus = (item, status, reason) => {
      item.status = status
      item.reason = reason
      item.updatedAt = new Date(now).toISOString()
      emit([{ type: status, repo: item.repo, pr: item.number, reason }])
    }

    const repos = [...new Set([...queue.items.filter((it) => !FINAL_STATUSES.has(it.status)).map((it) => it.repo), ...Object.keys(laneStates)])]
    for (const repo of repos) {
      const repoPolicy = selectRepoPolicy(policy, repo)
      const laneState = (laneStates[repo] ??= {})
      const pending = queue.items.filter((it) => it.repo === repo && !FINAL_STATUSES.has(it.status))
      if (!repoPolicy) {
        for (const item of pending) setStatus(item, 'rejected', 'repo_not_in_policy')
        continue
      }
      const lane = lanes.get(repoPolicy.lane)
      if (!lane) throw new Error(`policy 指向不存在的车道: ${repoPolicy.lane}`)
      const expire = (item) => {
        if (now - Date.parse(item.authorizedAt) <= AUTH_TTL_MS) return false
        setStatus(item, 'expired', `授权超过 7 天（${item.authorizedAt}）`)
        return true
      }
      if (laneState.frozen) {
        pending.forEach(expire)
        continue
      }
      const client = clientFor(repo)

      if (lane.beforeItems) {
        const pre = await lane.beforeItems({ repo, laneState, client, now, repoPolicy })
        emit(pre.events)
        if (pre.stopLane || laneState.frozen) continue
      }

      for (const item of pending) {
        if (expire(item)) continue
        const missing = item.after.find((id) => !byId.has(id))
        if (missing) {
          setStatus(item, 'blocked_by_dependency', `依赖 ${missing} 不在队列里`)
          continue
        }
        const deps = item.after.map((id) => byId.get(id))
        const deadDep = deps.find((d) => FINAL_STATUSES.has(d.status) && d.status !== 'merged')
        if (deadDep) {
          setStatus(item, 'blocked_by_dependency', `依赖 ${deadDep.id} 为 ${deadDep.status}`)
          continue
        }
        if (deps.some((d) => d.status !== 'merged')) {
          item.reason = `等依赖合入: ${deps.filter((d) => d.status !== 'merged').map((d) => d.id).join(', ')}`
          continue
        }

        const facts = createFacts({ client, repo, number: item.number })
        const result = await lane.process({ item, repoPolicy, laneState, client, facts, gates, now, shadow })
        emit(result.events)
        if (result.status) setStatus(item, result.status, result.reason)
        else if (result.reason) item.reason = result.reason
        item.lastCheckedAt = new Date(now).toISOString()
        if (result.stopLane || laneState.frozen) break
      }
    }

    emit(settleAutoIntakeErrors({ queue, laneStates, errors: intake.errors }))
    for (const [repo, state] of Object.entries(laneStates)) if (Object.keys(state).length === 0) delete laneStates[repo]
    store.saveQueue(queue)
    store.saveLanes(laneStates)
    return { events }
  } finally {
    release()
  }
}

export function unfreezeLane(store, repo) {
  const release = store.acquireLock()
  if (!release) throw new Error('另一个进程持有锁，稍后再试')
  try {
    const lanes = store.loadLanes()
    const key = repo.toLowerCase()
    if (!lanes[key]?.frozen) return false
    delete lanes[key].frozen
    store.saveLanes(lanes)
    store.appendLog({ type: 'lane_unfrozen', repo: key })
    return true
  } finally {
    release()
  }
}
