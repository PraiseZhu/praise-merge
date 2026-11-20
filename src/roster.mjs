// 组织名册（#53）：按 GitHub 账号取公司邮箱，判断机器人账号。
// 名册正文是 xindong/org 的 README 表格，一行一个人：| [@login](url) | 中文名 | 公司邮箱 | 角色 |。
// 解析做法与 PraiseZhu/Review-PR review-pr/scripts/lib.mjs 的 parseRosterLine、mivo/lib/feishu-notify.mjs 的 selectRosterEmail 相同；
// 两个仓在 Mini 上各自部署，这里照抄，不跨仓引用。邮箱只在发送时用，不写进事件、日志和结果。
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

// 机器人账号：GitHub App 写成 <name>[bot] 或 app/<name>；没有账号也按机器人处理（没法找人）
export function isBotLogin(login) {
  const text = String(login ?? '')
  return !text || /\[bot\]$/i.test(text) || /^app\//i.test(text)
}

// 名册的一行 → { login, email }；不是带账号和邮箱的行返回 null
export function toRosterRow(line) {
  const cells = String(line).split('|').map((cell) => cell.trim()).filter((cell) => cell !== '')
  const login = cells.map((cell) => cell.match(/\[@([^\]]+)\]/)?.[1]).find(Boolean) ?? null
  const email = cells.find((cell) => EMAIL.test(cell)) ?? null
  return login && email ? { login, email } : null
}

// 名册正文（可以有多份）里这个 GitHub 账号的公司邮箱；没有返回 null。按账号精确匹配，不分大小写，取先出现的一行
export function selectRosterEmail(rosterTexts, login) {
  const want = String(login ?? '').toLowerCase()
  if (!want) return null
  for (const text of rosterTexts ?? []) {
    for (const line of String(text).split(/\r?\n/)) {
      const row = toRosterRow(line)
      if (row && row.login.toLowerCase() === want) return row.email
    }
  }
  return null
}

// 不分大小写去重的 GitHub 账号列表，保留先出现的写法；空的丢掉
export function toDistinctLogins(logins) {
  const seen = new Set()
  return (logins ?? []).filter((login) => {
    const key = String(login ?? '').toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
