// 用飞书「Mivo」机器人发文本私聊（#48，2026-11-12 用户定：CI 变红用这个机器人通知）。
// 做法与 PraiseZhu/Review-PR mivo/lib/feishu-notify.mjs（审查熔断私聊）相同：tenant_access_token → 按邮箱查 open_id → 发 text 消息。
// 一轮可能发给好几个人（#53：弄红它的 PR 作者、集成分支负责人、兜底收件人），token 只取一次、open_id 一次查完，再逐条发。
// 应用密钥由调用方从 Mini 钥匙串读出传进来；返回值只有固定原因码，不含邮箱、密钥和飞书返回原文。只用 Node 内置的 fetch。
export const FEISHU_API = 'https://open.feishu.cn/open-apis'
export const FEISHU_STEP_TIMEOUT_MS = 8_000 // 每个请求的上限
export const FEISHU_TOTAL_TIMEOUT_MS = 15_000 // 整个发送过程的上限：巡检脚本整轮 170 秒，tick 自己最多 150 秒
const LOOKUP_BATCH = 50 // batch_get_id 一次最多查 50 个邮箱

async function postJson({ fetchFn, url, body, token, total }) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(FEISHU_STEP_TIMEOUT_MS), total]),
  })
  // 响应体不是 JSON 才当空对象（原因码带 HTTP 状态）；读响应体时超时或断线照样抛出，记 timeout / network
  const data = await res.json().catch((err) => {
    if (err instanceof SyntaxError) return {}
    throw err
  })
  return { status: res.status, data }
}

const toThrownCode = (error) => (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network')

/**
 * 准备好一次发送：取 token，把 emails 里每个邮箱的 open_id 一次查完（不分大小写去重）。
 * 准备失败返回 { error: 原因码 }：no-credential、token-<code>、lookup-<code>、timeout、network。
 * 成功返回 { error: null, send }。send(email, text) 给这个邮箱的飞书用户发一条文本，各自记结果：
 * { status: 'sent' } 或 { status: 'failed', code }，code 是 feishu-user-not-found（这个邮箱查不到人）、send-<code>、timeout、network。
 * 后面一条超时或断线，不改前面已发出的结果，余下的照样尝试（整体超时后会很快各记 timeout）。
 */
export async function openFeishuSender({ fetchFn = fetch, apiBase = FEISHU_API, appId, appSecret, emails, totalTimeoutMs = FEISHU_TOTAL_TIMEOUT_MS }) {
  if (!appSecret) return { error: 'no-credential' }
  const total = AbortSignal.timeout(totalTimeoutMs)
  const toKey = (email) => String(email).toLowerCase()
  const openIds = new Map()
  let token
  try {
    const auth = await postJson({ fetchFn, url: `${apiBase}/auth/v3/tenant_access_token/internal`, body: { app_id: appId, app_secret: appSecret }, total })
    token = auth.data?.tenant_access_token
    if (auth.data?.code !== 0 || !token) return { error: `token-${auth.data?.code ?? auth.status}` }
    const wanted = [...new Map(emails.map((email) => [toKey(email), email])).values()]
    for (let i = 0; i < wanted.length; i += LOOKUP_BATCH) {
      const found = await postJson({ fetchFn, url: `${apiBase}/contact/v3/users/batch_get_id?user_id_type=open_id`, body: { emails: wanted.slice(i, i + LOOKUP_BATCH) }, token, total })
      if (found.data?.code !== 0) return { error: `lookup-${found.data?.code ?? found.status}` }
      for (const user of found.data?.data?.user_list ?? []) if (user.email && user.user_id) openIds.set(toKey(user.email), user.user_id)
    }
  } catch (error) {
    return { error: toThrownCode(error) }
  }
  async function send(email, text) {
    const openId = openIds.get(toKey(email))
    if (!openId) return { status: 'failed', code: 'feishu-user-not-found' }
    try {
      const sent = await postJson({ fetchFn, url: `${apiBase}/im/v1/messages?receive_id_type=open_id`, body: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) }, token, total })
      return sent.data?.code === 0 ? { status: 'sent' } : { status: 'failed', code: `send-${sent.data?.code ?? sent.status}` }
    } catch (error) {
      return { status: 'failed', code: toThrownCode(error) }
    }
  }
  return { error: null, send }
}

// 「弄红它的 PR」一行（#53）。cause 见 src/ci-watch.mjs 的 findRedCause；事件里没有 cause（升级前的事件）不加这一行，查不到（null）写「没查到」。
// 找准了写「弄红它的 PR」；找不准（更早的提交没法确认是绿的：没有结论、读不到、往回找走满步数或超时）写「最早确认变红的 PR」并说明不一定是它。
// 红从更早的提交开始时写明从哪个提交起；没有对应的 PR（直接推送）写提交和提交人。PR 链接放在行尾。
export function toCauseLine({ repo, head, cause }) {
  if (cause === undefined) return null
  if (cause === null) return '弄红它的 PR：没查到'
  const short = cause.sha.slice(0, 8)
  const doubt = cause.certain ? '' : '（没法确认更早的提交是绿的，不一定是它弄红的）'
  if (cause.pr === null) {
    const pushedBy = cause.author ? `${cause.author} 直接推送，没有对应的 PR` : '直接推送，没有对应的 PR，提交人未知'
    return `${cause.certain ? '弄红它的提交' : '最早确认变红的提交'}：${short}（${pushedBy}）${doubt}`
  }
  const since = cause.sha === head ? '' : `，从提交 ${short} 起一直红`
  return `${cause.certain ? '弄红它的 PR' : '最早确认变红的 PR'}：#${cause.pr}（${cause.author ?? '作者未知'}${since}）${doubt} https://github.com/${repo}/pull/${cause.pr}`
}

// CI 红灯事件行（toEventLines 的一行解析后）→ 飞书正文。reason 的格式见 src/ci-watch.mjs：
// main：`main <提交前 8 位> <失败项>`；集成分支：`<分支> <提交前 8 位> <失败项>（在用的 PR：#a、#b）`
// 收件人可能是第一次收到这个机器人消息的同事（#53），正文写明弄红它的 PR、分支负责人，最后一行说明这是自动通知
export function toCiRedText({ type, repo, branch, head, reason = '', cause, owners }) {
  const short = String(head ?? '').slice(0, 8)
  let detail = String(reason)
  const prefix = `${branch} ${short} `
  if (detail.startsWith(prefix)) detail = detail.slice(prefix.length)
  const usedBy = detail.match(/（在用的 PR：(.+)）$/)
  if (usedBy) detail = detail.slice(0, usedBy.index)
  const impact = type === 'main_ci_red'
    ? '合并通道已暂停，main 转全绿后约 1 分钟自动恢复'
    : `合进这个分支的 PR 先不合${usedBy ? `（在用的 PR：${usedBy[1]}）` : ''}`
  const causeLine = toCauseLine({ repo, head, cause })
  return [
    `Mivo CI 变红：${branch}`,
    `提交：${short}`,
    `失败：${detail}`,
    ...(causeLine ? [causeLine] : []),
    ...(type === 'integration_ci_red' && owners?.length ? [`分支负责人：${owners.join('、')}`] : []),
    `影响：${impact}`,
    `查看：https://github.com/${repo}/actions?query=branch%3A${encodeURIComponent(branch)}`,
    '（合并伙伴自动通知，在这里回复没人收得到）',
  ].join('\n')
}
