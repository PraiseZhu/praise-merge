// 用飞书「Mivo」机器人给用户发文本私聊（#48，2026-11-12 用户定：CI 变红用这个机器人通知）。
// 做法与 PraiseZhu/Review-PR mivo/lib/feishu-notify.mjs（审查熔断私聊）相同：tenant_access_token → 按邮箱查 open_id → 发 text 消息。
// 应用密钥由调用方从 Mini 钥匙串读出传进来；返回值只有固定原因码，不含邮箱、密钥和飞书返回原文。只用 Node 内置的 fetch。
export const FEISHU_API = 'https://open.feishu.cn/open-apis'
export const FEISHU_STEP_TIMEOUT_MS = 8_000 // 每个请求的上限
export const FEISHU_TOTAL_TIMEOUT_MS = 15_000 // 整个发送过程的上限：巡检脚本整轮 170 秒，tick 自己最多 150 秒

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
 * 给 email 对应的飞书用户依次发 texts 里的每条文本。取 token 和查 open_id 只做一次。
 * 返回与 texts 等长的结果：{ status: 'sent' } 或 { status: 'failed', code }。前面的步骤失败时每条都记同一个原因码。
 * 原因码：no-credential、token-<code>、lookup-<code>、feishu-user-not-found、send-<code>、timeout、network。
 */
export async function sendFeishuTexts({ fetchFn = fetch, apiBase = FEISHU_API, appId, appSecret, email, texts, totalTimeoutMs = FEISHU_TOTAL_TIMEOUT_MS }) {
  const all = (code) => texts.map(() => ({ status: 'failed', code }))
  if (!appSecret) return all('no-credential')
  const total = AbortSignal.timeout(totalTimeoutMs)
  try {
    const auth = await postJson({ fetchFn, url: `${apiBase}/auth/v3/tenant_access_token/internal`, body: { app_id: appId, app_secret: appSecret }, total })
    const token = auth.data?.tenant_access_token
    if (auth.data?.code !== 0 || !token) return all(`token-${auth.data?.code ?? auth.status}`)
    const found = await postJson({ fetchFn, url: `${apiBase}/contact/v3/users/batch_get_id?user_id_type=open_id`, body: { emails: [email] }, token, total })
    if (found.data?.code !== 0) return all(`lookup-${found.data?.code ?? found.status}`)
    const openId = found.data?.data?.user_list?.[0]?.user_id
    if (!openId) return all('feishu-user-not-found')
    // 每条各自记结果：后面一条超时或断线，不改前面已发出的结果，余下的照样尝试（整体超时后会很快各记 timeout）
    const results = []
    for (const text of texts) {
      try {
        const sent = await postJson({ fetchFn, url: `${apiBase}/im/v1/messages?receive_id_type=open_id`, body: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) }, token, total })
        results.push(sent.data?.code === 0 ? { status: 'sent' } : { status: 'failed', code: `send-${sent.data?.code ?? sent.status}` })
      } catch (error) {
        results.push({ status: 'failed', code: toThrownCode(error) })
      }
    }
    return results
  } catch (error) {
    return all(toThrownCode(error))
  }
}

// CI 红灯事件行（toEventLines 的一行解析后）→ 飞书正文。reason 的格式见 src/ci-watch.mjs：
// main：`main <提交前 8 位> <失败项>`；集成分支：`<分支> <提交前 8 位> <失败项>（在用的 PR：#a、#b）`
export function toCiRedText({ type, repo, branch, head, reason = '' }) {
  const short = String(head ?? '').slice(0, 8)
  let detail = String(reason)
  const prefix = `${branch} ${short} `
  if (detail.startsWith(prefix)) detail = detail.slice(prefix.length)
  const usedBy = detail.match(/（在用的 PR：(.+)）$/)
  if (usedBy) detail = detail.slice(0, usedBy.index)
  const impact = type === 'main_ci_red'
    ? '合并通道已暂停，main 转全绿后约 1 分钟自动恢复'
    : `合进这个分支的 PR 先不合${usedBy ? `（在用的 PR：${usedBy[1]}）` : ''}`
  return [
    `Mivo CI 变红：${branch}`,
    `提交：${short}`,
    `失败：${detail}`,
    `影响：${impact}`,
    `查看：https://github.com/${repo}/actions?query=branch%3A${encodeURIComponent(branch)}`,
  ].join('\n')
}
