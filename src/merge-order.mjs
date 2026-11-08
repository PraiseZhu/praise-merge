// PR 正文里的「合并顺序：」一行（#38，用户 2026-11-08 定）：写 PR 的会话把依赖写进正文，伙伴按它排队，不盲合。
// 写法：`合并顺序：无`（或 `无依赖`）表示没有依赖；否则这一行里出现的每个 `#号` / `owner/repo#号` 都是依赖，
// 例如 `合并顺序：等 #12、xindong/mivo-canvas-plugin#13 合入后`。`#号` 指本仓。
// HTML 注释里的内容不算（模板说明里可能出现示例）。
import { toPrId } from './request.mjs'

const LINE_RE = /^\s*(?:[-*]\s*)?合并顺序\s*[：:]\s*(.*?)\s*$/
const REF_RE = /(?:([\w.-]+\/[\w.-]+))?#(\d+)/g
const NONE_RE = /^(无|无依赖|none)(?:[\s，,。.（(].*)?$/i

const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '')

// 返回 { ok: true, after: [id] } 或 { ok: false, reason }；id 写法与队列一致（小写 owner/repo#号）
export function toMergeOrder(body, repo, number) {
  const lines = stripComments(body).split(/\r?\n/).map((l) => l.match(LINE_RE)).filter(Boolean)
  if (lines.length === 0) return { ok: false, reason: 'PR 正文缺少「合并顺序：」一行' }
  if (lines.length > 1) return { ok: false, reason: `PR 正文有 ${lines.length} 行「合并顺序：」，只能有一行` }
  const value = lines[0][1]
  const refs = [...value.matchAll(REF_RE)].map((m) => toPrId(m[1] ?? repo, Number(m[2])))
  if (refs.length === 0) {
    if (NONE_RE.test(value)) return { ok: true, after: [] }
    return { ok: false, reason: `「合并顺序：${value}」看不懂：没有依赖写「无」，有依赖写 #号 或 owner/repo#号` }
  }
  const self = toPrId(repo, number)
  if (refs.includes(self)) return { ok: false, reason: `「合并顺序」里依赖了自己（${self}）` }
  return { ok: true, after: [...new Set(refs)] }
}

// 按正文自动接单的条目（orderFromBody），每轮处理前重新读正文、按最新的「合并顺序」判断依赖。
// 依赖在队列里已 merged，或 GitHub 上已合入 → 满足；还开着 → 等；关闭未合入、读不到、正文无效 → 不合，要人看。
// 返回 { ready, reason, blocked }：ready 才继续走车道；blocked 表示要叫醒伙伴（由调用方按原因去重）。
// 改 item.after 为正文里的最新依赖
export async function toBodyOrderVerdict({ item, facts, clientFor, byId }) {
  let pr
  try {
    pr = await facts.pr()
  } catch (err) {
    return { ready: false, reason: `merge_order: 读不到 PR 正文（${err.message}）`, blocked: false }
  }
  const order = toMergeOrder(pr.body, item.repo, item.number)
  if (!order.ok) return { ready: false, reason: `merge_order: ${order.reason}`, blocked: true }
  // 用户说「合并」时指定过的依赖（pinnedAfter）一直算数，和正文里的依赖合在一起
  const after = [...new Set([...order.after, ...(item.pinnedAfter ?? [])])]
  item.after = after
  const waiting = []
  for (const id of after) {
    if (byId.get(id)?.status === 'merged') continue
    const [depRepo, num] = id.split('#')
    let dep
    try {
      dep = await clientFor(depRepo).request('GET', `/repos/${depRepo}/pulls/${num}`)
    } catch (err) {
      return { ready: false, reason: `merge_order: 读不到依赖 ${id}（${err.message}）`, blocked: true }
    }
    if (dep.merged) continue
    if (dep.state !== 'open') return { ready: false, reason: `merge_order: 依赖 ${id} 已关闭但没有合入`, blocked: true }
    waiting.push(id)
  }
  if (waiting.length) return { ready: false, reason: `等依赖合入: ${waiting.join(', ')}`, blocked: false }
  return { ready: true }
}
