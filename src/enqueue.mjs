// 接收一份合并请求：先做 schema 校验，再用 App 只读确认每个 PR 的作者、状态和目标分支，最后写进队列。
// 同一个 PR 再次被授权时刷新授权时间和依赖，保留以往见过的 head。
import { MIVO_ACCEPTED_BASES, isMivoBase, selectRepoPolicy, toAuthorMismatch } from './policy.mjs'
import { FINAL_STATUSES } from './queue.mjs'
import { toValidatedRequest } from './request.mjs'

export async function enqueueRequest({ store, policy, clientFor, request, now = Date.now() }) {
  const release = store.acquireLock()
  if (!release) throw new Error('另一个进程持有锁，稍后再试')
  try {
    const queue = store.loadQueue()
    const byId = new Map(queue.items.map((it) => [it.id, it]))
    const knownIds = new Set(queue.items.filter((it) => !FINAL_STATUSES.has(it.status) || it.status === 'merged').map((it) => it.id))
    const validated = toValidatedRequest(request, { policy, knownIds })
    if (!validated.ok) {
      store.appendLog({ type: 'request_rejected', session: request?.session_id ?? null, reason: validated.reason }, now)
      return { ok: false, reason: validated.reason }
    }

    const rejected = [...validated.rejected]
    const accepted = []
    for (const pr of validated.prs) {
      const data = await clientFor(pr.repo).request('GET', `/repos/${pr.repo}/pulls/${pr.number}`)
      const lane = selectRepoPolicy(policy, pr.repo).lane
      // 作者名单按车道：Mivo 另认 praise-qa[bot]，个人仓只认 PraiseZhu
      const authorMismatch = toAuthorMismatch(lane, data.user?.login)
      if (authorMismatch) { rejected.push({ id: pr.id, reason: `author ${authorMismatch}` }); continue }
      if (data.state !== 'open') { rejected.push({ id: pr.id, reason: `pr_${data.merged ? 'merged' : data.state}` }); continue }
      if (lane === 'mivo' && !isMivoBase(data.base?.ref)) { rejected.push({ id: pr.id, reason: `base 期望 ${MIVO_ACCEPTED_BASES}，实际 ${data.base?.ref}` }); continue }
      // 记下授权时的目标分支：之后 PR 被改到别的分支，车道按「目标分支变了」不合
      accepted.push({ ...pr, base: data.base?.ref ?? null })
    }
    // 被拒的 PR 还被别人依赖时，依赖方也不收
    const rejectedIds = new Set(rejected.map((r) => r.id))
    for (let changed = true; changed;) {
      changed = false
      for (const pr of [...accepted]) {
        const dep = pr.after.find((id) => rejectedIds.has(id))
        if (!dep) continue
        accepted.splice(accepted.indexOf(pr), 1)
        rejected.push({ id: pr.id, reason: `依赖 ${dep} 被拒收` })
        rejectedIds.add(pr.id)
        changed = true
      }
    }

    const stamp = new Date(now).toISOString()
    for (const pr of accepted) {
      const prev = byId.get(pr.id)
      const item = {
        id: pr.id,
        repo: pr.repo,
        number: pr.number,
        base: pr.base,
        status: 'queued',
        reason: 'queued',
        after: pr.after,
        authorizedAt: request.authorized_at,
        authorizationText: request.authorization_text,
        sessionId: request.session_id,
        sessionTitle: request.session_title ?? null,
        headShaAtAuth: pr.headShaAtAuth,
        seenHeads: [...new Set([...(prev?.seenHeads ?? []), pr.headShaAtAuth])],
        enqueuedAt: prev?.enqueuedAt ?? stamp,
        updatedAt: stamp,
      }
      if (prev) queue.items[queue.items.indexOf(prev)] = item
      else queue.items.push(item)
    }
    store.saveQueue(queue)
    store.appendLog({ type: 'request_accepted', session: request.session_id, accepted: accepted.map((p) => p.id), rejected }, now)
    return { ok: true, accepted: accepted.map((p) => p.id), rejected }
  } finally {
    release()
  }
}
