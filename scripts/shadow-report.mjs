#!/usr/bin/env node
// 影子对账日报：最近 24 小时里每条 would_* 记录对应的 PR 后来实际怎样，有没有授权过的 PR 被人工合了却没有 would_*。
// 只读：只用 App 令牌发 GET。用法：node scripts/shadow-report.mjs [--config <dir>] [--json]
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from '../src/policy.mjs'
import { createStore, selectStateDir } from '../src/queue.mjs'
import { createClientFactory } from '../src/cli.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const WOULD_ACT = new Set(['would_merge', 'would_enqueue'])

function readEvents(logsDir) {
  if (!existsSync(logsDir)) return { events: [], firstAt: null }
  const files = readdirSync(logsDir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
  const events = []
  for (const f of files) {
    for (const line of readFileSync(join(logsDir, f), 'utf8').split('\n')) {
      if (line.trim()) events.push(JSON.parse(line))
    }
  }
  return { events, firstAt: events.length ? Date.parse(events[0].at) : null }
}

export async function buildShadowReport({ stateDir, clientFor, now = Date.now() }) {
  const { events, firstAt } = readEvents(join(stateDir, 'logs'))
  const since = now - DAY_MS
  const recent = events.filter((e) => Date.parse(e.at) >= since)
  const day = firstAt === null ? 0 : Math.floor((now - firstAt) / DAY_MS) + 1

  const would = new Map()
  for (const e of recent) {
    if (!e.type?.startsWith('would_') || !e.repo || !e.pr) continue
    const id = `${e.repo}#${e.pr}`
    if (!would.has(id)) would.set(id, { id, repo: e.repo, pr: e.pr, types: new Set() })
    would.get(id).types.add(e.type)
  }
  const queue = createStore(stateDir).loadQueue()
  const authorized = queue.items.filter((it) => !would.has(it.id))

  const fetchPr = async (repo, pr) => clientFor(repo).request('GET', `/repos/${repo}/pulls/${pr}`)
  const report = { day, generatedAt: new Date(now).toISOString(), consistent: [], risk: [], pendingOpen: [], updateOnly: [], missed: [] }

  for (const w of would.values()) {
    const pr = await fetchPr(w.repo, w.pr)
    const row = { id: w.id, url: pr.html_url, types: [...w.types].sort() }
    if (![...w.types].some((t) => WOULD_ACT.has(t))) report.updateOnly.push(row)
    else if (pr.merged) report.consistent.push({ ...row, mergedBy: pr.merged_by?.login ?? null, mergedAt: pr.merged_at })
    else if (pr.state === 'closed') report.risk.push({ ...row, reason: '引擎认为可合，但这个 PR 后来被关闭、没有合并' })
    else report.pendingOpen.push(row)
  }
  for (const it of authorized) {
    const pr = await fetchPr(it.repo, it.number)
    if (pr.merged && Date.parse(pr.merged_at) >= since) {
      report.missed.push({ id: it.id, url: pr.html_url, mergedBy: pr.merged_by?.login ?? null, mergedAt: pr.merged_at, lastReason: it.reason })
    }
  }
  return report
}

export function toReportMarkdown(r) {
  const head = r.risk.length
    ? `⚠️ 影子对账第 ${r.day} 天：误判风险 ${r.risk.length} 条，必须先看`
    : `影子对账第 ${r.day} 天：一致 ${r.consistent.length}，误判风险 0，漏判 ${r.missed.length}，等人工合并 ${r.pendingOpen.length}`
  const lines = [head]
  const section = (title, rows, fmt) => { if (rows.length) lines.push('', `**${title}**`, ...rows.map(fmt)) }
  section('误判风险（引擎会合，但 PR 被关了）', r.risk, (x) => `- [${x.id}](${x.url})：${x.reason}`)
  section('一致（引擎会合，人工也合了）', r.consistent, (x) => `- [${x.id}](${x.url})：${x.mergedBy} 于 ${x.mergedAt} 合并`)
  section('漏判（授权过、人工合了，引擎没判可合）', r.missed, (x) => `- [${x.id}](${x.url})：${x.mergedBy} 于 ${x.mergedAt} 合并；引擎最后的理由：${x.lastReason}`)
  section('等人工合并（引擎判可合，PR 还开着）', r.pendingOpen, (x) => `- [${x.id}](${x.url})`)
  section('只会追 base', r.updateOnly, (x) => `- [${x.id}](${x.url})`)
  if (r.day >= 7 && r.risk.length === 0) lines.push('', '影子运行已满 7 天。如果此前每天都没有误判风险，就满足打开真实合并的条件（见 docs/operations.md「影子模式与真实合并」）。')
  return lines.join('\n')
}

const isMain = () => process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain()) {
  const i = process.argv.indexOf('--config')
  const configDir = i >= 0 ? process.argv[i + 1] : process.env.PRAISE_MERGE_CONFIG || join(dirname(fileURLToPath(import.meta.url)), '..', 'config')
  const { app } = readConfig(configDir)
  buildShadowReport({ stateDir: selectStateDir(), clientFor: createClientFactory({ ...app, shadow: true }) }).then((r) => {
    process.stdout.write(`${process.argv.includes('--json') ? JSON.stringify(r) : toReportMarkdown(r)}\n`)
  }, (err) => {
    process.stderr.write(`shadow-report: ${err.message}\n`)
    process.exitCode = 1
  })
}
