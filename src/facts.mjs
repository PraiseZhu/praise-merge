// 一轮里对单个 PR 的只读事实，按需取、取过就缓存。门禁和车道都从这里读，不各自拼请求。
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

export function createFacts({ client, repo, number }) {
  const [owner, name] = repo.split('/')
  const memo = new Map()
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn())
    return memo.get(key)
  }

  return {
    pr: () => once('pr', () => client.request('GET', `/repos/${repo}/pulls/${number}`)),
    // PR 自身的改动（相对 merge base），用来算 patch-id
    prDiff: () => once('diff', () => client.request('GET', `/repos/${repo}/pulls/${number}`, null, { accept: 'application/vnd.github.diff' })),
    repoInfo: () => once('repo', () => client.request('GET', `/repos/${repo}`)),
    // 指定提交上按名字取最新一次结果：check run 用 name，commit status 用 context
    checkStates: (sha) => once(`checks:${sha}`, async () => {
      const states = new Map()
      for (let page = 1; page <= 10; page++) {
        const data = await client.request('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`)
        for (const run of data.check_runs ?? []) {
          const prev = states.get(run.name)
          if (prev?.kind === 'check' && prev.id > run.id) continue
          const passed = run.status === 'completed' && PASSING_CONCLUSIONS.has(run.conclusion)
          states.set(run.name, { kind: 'check', id: run.id, appId: run.app?.id ?? null, state: run.status === 'completed' ? run.conclusion : run.status, passed })
        }
        if ((data.check_runs ?? []).length < 100) break
      }
      const combined = await client.request('GET', `/repos/${repo}/commits/${sha}/status?per_page=100`)
      for (const st of combined.statuses ?? []) {
        if (states.has(st.context)) continue // 同名 check run 优先
        states.set(st.context, { kind: 'status', id: st.id, creator: st.creator?.login ?? null, state: st.state, passed: st.state === 'success', description: st.description ?? '', createdAt: st.created_at ?? null })
      }
      return states
    }),
    unresolvedThreads: () => once('threads', async () => {
      const data = await client.graphql(
        'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved}}}}}',
        { owner, name, number },
      )
      const threads = data.repository.pullRequest.reviewThreads
      if (threads.totalCount > threads.nodes.length) throw new Error(`讨论串超过 ${threads.nodes.length} 条，无法确认全部已解决`)
      return threads.nodes.filter((t) => !t.isResolved).length
    }),
    // base 分支相对 head 的落后数
    behindBy: (baseRef, headSha) => once(`behind:${baseRef}:${headSha}`, async () => {
      const data = await client.request('GET', `/repos/${repo}/compare/${encodeURIComponent(baseRef)}...${headSha}`)
      return data.behind_by
    }),
  }
}
