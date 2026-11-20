// CI 红灯的飞书通知发给谁（#53，2026-11-20 用户定：「谁的 pr 让 main 红了飞书通知谁；谁的集成分支红了飞书通知谁」，
// 「通报到 pr 负责人，而不是都到我这里」）。
// 通知对象：main 是弄红它的 PR 作者；集成分支是分支负责人加弄红它的 PR 作者（事件里的 owners、cause，见 src/ci-watch.mjs）。
// GitHub 账号 → 名册里的公司邮箱 → 飞书。有任何一个没通知到，或一个通知对象都没有，另发一条给兜底收件人（app.json 的 feishu.to_email，
// 就是用户），第一行写明没通知到谁、为什么。通知到人了就不再抄送用户。
// 结果里只有 GitHub 账号和原因码，没有邮箱。
import { toCiRedText } from './feishu.mjs'
import { isBotLogin, selectRosterEmail, toDistinctLogins } from './roster.mjs'

// 没通知到的原因码 → 给人看的说法；飞书发送失败的原因码（send-<code>、timeout、network）原样带上
const MISS_TEXT = {
  bot: '机器人账号',
  'not-in-roster': '名册里没有',
  'roster-unavailable': '名册读不到',
  'feishu-user-not-found': '名册里的邮箱飞书查不到',
}
export const toMissText = (reason) => MISS_TEXT[reason] ?? `飞书没发出去，原因码 ${reason}`

// 这条红灯该通知的 GitHub 账号：集成分支负责人在前，弄红它的 PR 作者在后，不分大小写去重
export const toRedTargets = (ev) => toDistinctLogins([...(ev.owners ?? []), ev.cause?.author])

/**
 * 通知对象逐个对到名册邮箱。rosterTexts 是读到的名册正文，一份都没读到传空数组。
 * 返回 { direct: [{ login, email }], missed: [{ login, reason }] }；两个账号对到同一个邮箱只留先出现的。
 */
export function toRedNoticePlan(ev, { rosterTexts }) {
  const direct = []
  const missed = []
  const seen = new Set()
  for (const login of toRedTargets(ev)) {
    if (isBotLogin(login)) {
      missed.push({ login, reason: 'bot' })
      continue
    }
    if (!rosterTexts.length) {
      missed.push({ login, reason: 'roster-unavailable' })
      continue
    }
    const email = selectRosterEmail(rosterTexts, login)
    if (!email) {
      missed.push({ login, reason: 'not-in-roster' })
      continue
    }
    if (seen.has(email.toLowerCase())) continue
    seen.add(email.toLowerCase())
    direct.push({ login, email })
  }
  return { direct, missed }
}

// 转给兜底收件人时正文前加的一行；没有要说明的返回 null
export function toForwardNote({ missed, noTarget }) {
  if (noTarget) return '没找到该通知谁，这条先发给你。'
  if (!missed.length) return null
  return `没通知到 ${missed.map((m) => `@${m.login}（${toMissText(m.reason)}）`).join('、')}，这条先转给你。`
}

/**
 * 按 plans 逐条红灯发飞书。sender 是 openFeishuSender 的返回值（只用 send）。
 * 先发给对得上的通知对象；发送失败的并进没通知到的名单。名单不空、或一个通知对象都没有，再给兜底收件人发一条（带说明）。
 * 兜底收件人自己就是通知对象时只收这一条，不重复发。
 * 返回逐条结果 { branch, to, status, code?, fallback?, noTarget?, missed? }：to 是 GitHub 账号；
 * 发给兜底收件人、且他不是通知对象时 to 为 null、fallback 为 true；missed 是这条消息替谁转的，noTarget 表示一个通知对象都没有。
 */
export async function sendRedNotices({ red, plans, sender, fallbackEmail }) {
  const results = []
  const fallbackKey = fallbackEmail.toLowerCase()
  for (const [i, ev] of red.entries()) {
    const { direct, missed } = plans[i]
    const body = toCiRedText(ev)
    const stillMissed = [...missed]
    let fallbackLogin = null
    for (const { login, email } of direct) {
      if (email.toLowerCase() === fallbackKey) {
        fallbackLogin = login
        continue
      }
      const sent = await sender.send(email, body)
      results.push({ branch: ev.branch, to: login, ...sent })
      if (sent.status !== 'sent') stillMissed.push({ login, reason: sent.code })
    }
    const noTarget = direct.length === 0 && missed.length === 0
    if (fallbackLogin === null && stillMissed.length === 0 && !noTarget) continue
    const note = toForwardNote({ missed: stillMissed, noTarget })
    const sent = await sender.send(fallbackEmail, note ? `${note}\n${body}` : body)
    results.push({ branch: ev.branch, to: fallbackLogin, ...sent, ...(fallbackLogin === null ? { fallback: true } : {}), ...(noTarget ? { noTarget: true } : {}), ...(stillMissed.length ? { missed: stillMissed } : {}) })
  }
  return results
}

// 给伙伴看的一行：这条红灯的飞书发给了谁、发没发出去、没通知到谁
export function toFeishuNote(result) {
  const who = result.to ? ` @${result.to}` : result.fallback ? '用户（兜底）' : null
  const missed = result.noTarget ? '；没找到该通知谁'
    : result.missed?.length ? `；没通知到 ${result.missed.map((m) => `@${m.login}（${toMissText(m.reason)}）`).join('、')}` : ''
  if (result.status === 'sent') return `飞书（Mivo 机器人）已发给${who}：${result.branch} CI 变红${missed}。`
  return `飞书（Mivo 机器人）没发${who ? `给${who}` : '出去'}：${result.branch} CI 变红，原因码 ${result.code}${missed}。`
}
