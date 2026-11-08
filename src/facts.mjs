// 一轮里对单个 PR 的只读事实，按需取、取过就缓存。门禁和车道都从这里读，不各自拼请求。
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

export function createFacts({ client, repo, number }) {
  const [owner, name] = repo.split('/')
  const memo = new Map()
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn())
    return memo.get(key)
  }
  // 汇总接口 /status 返回的 status 不带 creator，写入方只能从逐条列表接口 /statuses 按 id 对上。
  // 列表按时间倒序列出全部历史；有 id 对不上说明没读全，报错（门禁按失败处理），不把写入方当成空
  const readStatusCreators = async (sha, wanted) => {
    const creators = new Map()
    for (let page = 1; page <= 10 && creators.size < wanted.size; page++) {
      const batch = (await client.request('GET', `/repos/${repo}/commits/${sha}/statuses?per_page=100&page=${page}`)) ?? []
      for (const st of batch) if (wanted.has(st.id)) creators.set(st.id, st.creator?.login ?? null)
      if (batch.length < 100) break
    }
    if (creators.size < wanted.size) throw new Error(`commit status 写入方读不全：${sha.slice(0, 8)} 共 ${wanted.size} 个 context，只对上 ${creators.size} 个`)
    return creators
  }

  return {
    pr: () => once('pr', () => client.request('GET', `/repos/${repo}/pulls/${number}`)),
    // PR 自身的改动（相对 merge base），用来算 patch-id
    prDiff: () => once('diff', () => client.request('GET', `/repos/${repo}/pulls/${number}`, null, { accept: 'application/vnd.github.diff' })),
    repoInfo: () => once('repo', () => client.request('GET', `/repos/${repo}`)),
    // 指定提交上按名字取最新一次结果：check run 用 name，commit status 用 context
    checkStates: (sha) => once(`checks:${sha}`, async () => {
      const states = new Map()
      // check run 也按 total_count 核对：读到 10 页上限还没读全就报错（门禁按失败处理），不把读到的部分当成全部
      let runsRead = 0
      let runsTotal = 0
      for (let page = 1; page <= 10; page++) {
        const data = await client.request('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`)
        const batch = data.check_runs ?? []
        runsRead += batch.length
        runsTotal = data.total_count ?? runsRead
        for (const run of batch) {
          const prev = states.get(run.name)
          if (prev?.kind === 'check' && prev.id > run.id) continue
          const passed = run.status === 'completed' && PASSING_CONCLUSIONS.has(run.conclusion)
          states.set(run.name, { kind: 'check', id: run.id, appId: run.app?.id ?? null, state: run.status === 'completed' ? run.conclusion : run.status, passed })
        }
        if (batch.length < 100 || runsRead >= runsTotal) break
      }
      if (runsRead < runsTotal) throw new Error(`check run 读不全：${sha.slice(0, 8)} 共 ${runsTotal} 个，只读到 ${runsRead} 个`)
      // combined status 每页最多 100 个 context：读完所有页，读不全就报错（门禁按失败处理），不让漏掉的结论被旧 head 顶替
      const statuses = []
      let total = 0
      for (let page = 1; page <= 10; page++) {
        const combined = await client.request('GET', `/repos/${repo}/commits/${sha}/status?per_page=100&page=${page}`)
        const batch = combined.statuses ?? []
        statuses.push(...batch)
        total = combined.total_count ?? statuses.length
        if (batch.length < 100 || statuses.length >= total) break
      }
      if (statuses.length < total) throw new Error(`commit status 读不全：${sha.slice(0, 8)} 共 ${total} 个 context，只读到 ${statuses.length} 个`)
      const creators = statuses.length ? await readStatusCreators(sha, new Set(statuses.map((st) => st.id))) : new Map()
      for (const st of statuses) {
        const entry = { kind: 'status', id: st.id, creator: creators.get(st.id), state: st.state, passed: st.state === 'success', description: st.description ?? '', createdAt: st.created_at ?? null }
        const run = states.get(st.context)
        // 同名 check run 优先；被遮住的 status 挂在它下面，required_checks = "all" 两个来源都要看
        if (run) run.shadowedStatus = entry
        else states.set(st.context, entry)
      }
      return states
    }),
    // head 提交最近一次被推到 PR 分支的时间（毫秒）。没有 CI 的仓按它算 10 分钟宽限；读不到就报错，门禁按失败处理
    headPushedAt: (pr) => once(`pushed:${pr.head.sha}`, async () => {
      const headRepo = pr.head.repo?.full_name ?? repo
      const activity = await client.request('GET', `/repos/${headRepo}/activity?ref=${encodeURIComponent(`refs/heads/${pr.head.ref}`)}&per_page=100`)
      // 按时间倒序返回，第一条对上的就是最近一次
      const push = (activity ?? []).find((a) => a.after === pr.head.sha)
      const at = Date.parse(push?.timestamp)
      if (Number.isNaN(at)) throw new Error(`读不到 head ${pr.head.sha.slice(0, 8)} 的推送时间（${headRepo} ${pr.head.ref} 最近 100 次活动里没有）`)
      return at
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
    // 这个标签最近一次被挂上（labeled 事件）的操作者，没有这样的事件返回 null。
    // 事件按时间正序分页返回，最近一次在最后几页：读完所有页（最多 10 页），读不全就报错，不拿读到的部分当最近一次
    labelActor: (label) => once(`labelActor:${label}`, async () => {
      let latest = null
      for (let page = 1; page <= 10; page++) {
        const batch = (await client.request('GET', `/repos/${repo}/issues/${number}/events?per_page=100&page=${page}`)) ?? []
        for (const ev of batch) if (ev.event === 'labeled' && ev.label?.name === label && !(latest?.id > ev.id)) latest = ev
        if (batch.length < 100) return latest ? { login: latest.actor?.login ?? null, at: latest.created_at ?? null } : null
      }
      throw new Error(`issue events 读不全：#${number} 超过 1000 条`)
    }),
    // base 分支相对 head 的落后数
    behindBy: (baseRef, headSha) => once(`behind:${baseRef}:${headSha}`, async () => {
      const data = await client.request('GET', `/repos/${repo}/compare/${encodeURIComponent(baseRef)}...${headSha}`)
      return data.behind_by
    }),
  }
}
