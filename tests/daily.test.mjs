// #12：影子对账日报、每日自检
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildShadowReport, toReportMarkdown } from '../scripts/shadow-report.mjs'
import { toDailyProblems } from '../scripts/daily-check.mjs'
import { createClient } from '../src/github.mjs'
import { createStore } from '../src/queue.mjs'
import { makeTempDir } from './helpers/fake-github.mjs'

const NOW = Date.parse('2026-11-13T14:00:00Z')
const HOUR = 60 * 60 * 1000

// 假 GitHub：只认 GET /repos/<repo>/pulls/<n>，记录所有请求
function fakePrs(prs) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url)
    calls.push({ method: init.method ?? 'GET', path: pathname })
    const m = pathname.match(/^\/repos\/(.+\/.+)\/pulls\/(\d+)$/)
    const pr = m && prs[`${m[1]}#${m[2]}`]
    return new Response(JSON.stringify(pr ?? { message: 'Not Found' }), { status: pr ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }
  const client = createClient({ getToken: async () => 't', fetchImpl, shadow: true })
  return { clientFor: () => client, calls }
}

function stateWith({ events, items = [] }) {
  const dir = makeTempDir()
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const byDay = new Map()
  for (const e of events) {
    const day = e.at.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)])
  }
  for (const [day, lines] of byDay) writeFileSync(join(dir, 'logs', `events-${day}.jsonl`), `${lines.join('\n')}\n`)
  const store = createStore(dir)
  store.saveQueue({ items })
  return dir
}

const at = (msAgo) => new Date(NOW - msAgo).toISOString()
const pr = (overrides) => ({ html_url: 'https://github.com/x/pull/1', state: 'open', merged: false, merged_at: null, merged_by: null, ...overrides })

test('SC1 对账：一致、误判风险、漏判、等人工合并分开列；第一行标出误判风险；写明第几天', async () => {
  const dir = stateWith({
    events: [
      { at: at(7 * 24 * HOUR - HOUR), type: 'request_accepted' }, // 最早一条，影子第 7 天
      { at: at(5 * HOUR), type: 'would_merge', repo: 'praisezhu/a', pr: 1, head: 'h' },
      { at: at(4 * HOUR), type: 'would_merge', repo: 'praisezhu/a', pr: 1, head: 'h' },
      { at: at(3 * HOUR), type: 'would_enqueue', repo: 'xindong/mivo-canvas-plugin', pr: 9, head: 'h' },
      { at: at(2 * HOUR), type: 'would_merge', repo: 'praisezhu/a', pr: 3, head: 'h' },
      { at: at(30 * HOUR), type: 'would_merge', repo: 'praisezhu/a', pr: 8, head: 'h' }, // 超过 24 小时，不算
    ],
    items: [
      { id: 'praisezhu/a#4', repo: 'praisezhu/a', number: 4, status: 'queued', reason: 'evidence: gpt-review: missing', authorizedAt: at(10 * HOUR) },
      { id: 'praisezhu/a#5', repo: 'praisezhu/a', number: 5, status: 'queued', reason: 'x', authorizedAt: at(10 * HOUR) },
    ],
  })
  const { clientFor, calls } = fakePrs({
    'praisezhu/a#1': pr({ state: 'closed', merged: true, merged_at: at(HOUR), merged_by: { login: 'PraiseZhu' } }),
    'xindong/mivo-canvas-plugin#9': pr({ state: 'closed', merged: false }),
    'praisezhu/a#3': pr({}),
    'praisezhu/a#4': pr({ state: 'closed', merged: true, merged_at: at(2 * HOUR), merged_by: { login: 'PraiseZhu' } }),
    'praisezhu/a#5': pr({}),
  })
  const r = await buildShadowReport({ stateDir: dir, clientFor, now: NOW })
  assert.equal(r.day, 7)
  assert.deepEqual(r.consistent.map((x) => x.id), ['praisezhu/a#1'])
  assert.deepEqual(r.risk.map((x) => x.id), ['xindong/mivo-canvas-plugin#9'])
  assert.deepEqual(r.pendingOpen.map((x) => x.id), ['praisezhu/a#3'])
  assert.deepEqual(r.missed.map((x) => x.id), ['praisezhu/a#4'])
  assert.match(r.missed[0].lastReason, /gpt-review: missing/)
  const md = toReportMarkdown(r)
  assert.match(md.split('\n')[0], /^⚠️ 影子对账第 7 天：误判风险 1 条/)
  assert.doesNotMatch(md, /praisezhu\/a#8/)
  // SC2：只发 GET
  assert.ok(calls.length > 0)
  assert.ok(calls.every((c) => c.method === 'GET'))
})

test('没有日志时是第 0 天，报告为空；满 7 天且无误判时提示可以打开真实合并', async () => {
  const empty = await buildShadowReport({ stateDir: makeTempDir(), clientFor: fakePrs({}).clientFor, now: NOW })
  assert.equal(empty.day, 0)
  assert.match(toReportMarkdown(empty), /^影子对账第 0 天：一致 0，误判风险 0，漏判 0/)
  const md = toReportMarkdown({ ...empty, day: 7 })
  assert.match(md, /影子运行已满 7 天/)
})

test('SC3 自检：版本落后、doctor 失败、授权 24 小时内过期都列出；全部正常时没有问题', () => {
  const SHA = 'a'.repeat(40)
  const queue = { items: [
    { id: 'praisezhu/a#1', status: 'queued', reason: 'r1', authorizedAt: new Date(NOW - 6.5 * 24 * HOUR).toISOString() },
    { id: 'praisezhu/a#2', status: 'queued', reason: 'r2', authorizedAt: new Date(NOW - 5 * 24 * HOUR).toISOString() },
    { id: 'praisezhu/a#3', status: 'merged', reason: 'm', authorizedAt: new Date(NOW - 6.9 * 24 * HOUR).toISOString() },
  ] }
  const problems = toDailyProblems({ doctorResults: [{ name: 'key_mode_600', ok: false, detail: '实际 644' }, { name: 'config', ok: true }], version: 'b'.repeat(40), mainSha: SHA, queue, now: NOW })
  assert.equal(problems.length, 3)
  assert.match(problems[0], /doctor 未通过：key_mode_600 实际 644/)
  assert.match(problems[1], /运行目录落后：VERSION bbbbbbb，main aaaaaaa/)
  assert.match(problems[2], /授权快过期：praisezhu\/a#1/)
  assert.deepEqual(toDailyProblems({ doctorResults: [{ name: 'config', ok: true }], version: SHA, mainSha: SHA, queue: { items: [] }, now: NOW }), [])
})
