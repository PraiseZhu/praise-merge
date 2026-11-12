#!/usr/bin/env node
// Cindy 定时任务（script 模式，零 token）的入口：每轮跑一次 `praise-merge tick`，写心跳；
// 有要人看的事件或健康告警时，用 sessions.dispatch 叫醒合并伙伴，否则安静结束。
//
// stdout 只能写 cindy-script/1 协议帧；调试输出一律走 stderr。
// 环境变量：
//   PRAISE_MERGE_STATE / PRAISE_MERGE_CONFIG：同 bin/praise-merge
//   PRAISE_MERGE_PARTNER_SESSION：伙伴任务 id；不设时用宿主 start 帧 context 里的绑定任务
//   PRAISE_MERGE_TICK_CMD：测试用，JSON 数组形式的 tick 命令；默认 [node, bin/praise-merge, tick]
//   PRAISE_MERGE_FEISHU_SECRET_CMD / PRAISE_MERGE_FEISHU_API：测试用，见 notifyCiRed
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordRound } from '../src/heartbeat.mjs'
import { toEventLines } from '../src/events.mjs'
import { RED_EVENT_TYPES } from '../src/ci-watch.mjs'
import { toAppConfig } from '../src/policy.mjs'
import { FEISHU_API, sendFeishuTexts, toCiRedText } from '../src/feishu.mjs'
import { selectStateDir, createStore } from '../src/queue.mjs'

const PROTOCOL = 'cindy-script/1'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TICK_TIMEOUT_MS = 150_000

function createChannel() {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
  let nextId = 1
  const write = (frame) => process.stdout.write(`${JSON.stringify({ protocol: PROTOCOL, ...frame })}\n`)
  const read = async () => {
    for (;;) {
      const { value, done } = await lines.next()
      if (done) throw new Error('宿主关闭了协议通道')
      if (!value.trim()) continue
      const frame = JSON.parse(value)
      if (!['cindy-script/1', 'xdt-maker-script/1'].includes(frame.protocol)) throw new Error(`不支持的协议: ${frame.protocol}`)
      return frame
    }
  }
  return {
    async start() {
      const frame = await read()
      if (frame.type !== 'start') throw new Error(`期望 start 帧，实际 ${frame.type}`)
      return frame.context ?? {}
    },
    async call(method, params) {
      const id = `pm-${nextId++}`
      write({ type: 'call', id, method, params })
      const res = await read()
      if (res.type !== 'call_result' || res.id !== id) throw new Error('宿主回了不对应的帧')
      if (!res.ok) throw new Error(`${res.error?.code ?? 'INTERNAL'}: ${res.error?.message ?? 'host call failed'}`)
      return res.result
    },
    complete(resultText) {
      write({ type: 'complete', resultText, primarySessionId: null })
    },
  }
}

function runTickOnce(env) {
  const cmd = env.PRAISE_MERGE_TICK_CMD ? JSON.parse(env.PRAISE_MERGE_TICK_CMD) : [process.execPath, join(root, 'bin', 'praise-merge'), 'tick']
  const res = spawnSync(cmd[0], cmd.slice(1), { env, encoding: 'utf8', timeout: TICK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  if (res.stderr) process.stderr.write(res.stderr)
  if (res.error) return { ok: false, error: res.error.message }
  if (res.status !== 0) return { ok: false, error: (res.stderr || `exit ${res.status}`).trim().split('\n').pop() }
  try {
    return { ok: true, result: JSON.parse(res.stdout.trim().split('\n').pop()) }
  } catch {
    return { ok: false, error: 'tick 输出不是 JSON' }
  }
}

// CI 变红（#48）：脚本已用飞书「Mivo」机器人发过，给伙伴的消息里写明每条的结果，伙伴只在会话里转告
// feishu：[{ branch, status: 'sent' | 'failed', code }]，这一轮没有红灯时不传
export function toPartnerMessage(lines, { shadow, feishu = null }) {
  const notes = (feishu ?? []).map((r) => (r.status === 'sent'
    ? `飞书（Mivo 机器人）已发给用户：${r.branch} CI 变红。`
    : `飞书（Mivo 机器人）没发出去：${r.branch} CI 变红，原因码 ${r.code}。`))
  return [
    `praise-merge 事件（${lines.length} 条${shadow ? '，影子模式' : ''}）`,
    '```jsonl',
    ...lines,
    '```',
    '按 praise-merge 仓 docs/operations.md「伙伴怎么处理事件」通知用户。',
    ...notes,
  ].join('\n')
}

// CI 红灯事件逐条用飞书「Mivo」机器人私聊 app.json 里 feishu.to_email 的用户（#48）。
// 只在这一轮有红灯时调用：读 app.json 的 feishu 段、读 Mini 钥匙串里的应用密钥、发飞书。结果只有分支、状态和原因码。
// 测试用环境变量：PRAISE_MERGE_FEISHU_SECRET_CMD（JSON 数组形式的读密钥命令）、PRAISE_MERGE_FEISHU_API（飞书接口地址）
export async function notifyCiRed({ env, red, fetchFn = fetch }) {
  const each = (code) => red.map((ev) => ({ branch: ev.branch, status: 'failed', code }))
  let feishu
  try {
    const configDir = env.PRAISE_MERGE_CONFIG || join(root, 'config')
    feishu = toAppConfig(JSON.parse(readFileSync(join(configDir, 'app.json'), 'utf8'))).feishu
  } catch {
    return each('config-unreadable')
  }
  if (!feishu) return each('not-configured')
  const results = await sendFeishuTexts({
    fetchFn,
    apiBase: env.PRAISE_MERGE_FEISHU_API || FEISHU_API,
    appId: feishu.appId,
    appSecret: readKeychainSecret(env, feishu),
    email: feishu.toEmail,
    texts: red.map((ev) => toCiRedText(ev)),
  })
  return red.map((ev, i) => ({ branch: ev.branch, ...results[i] }))
}

// Mini 钥匙串里的应用密钥（和审查机熔断通知同一条目）；读不到返回 null（发送时记 no-credential）
function readKeychainSecret(env, feishu) {
  const cmd = env.PRAISE_MERGE_FEISHU_SECRET_CMD
    ? JSON.parse(env.PRAISE_MERGE_FEISHU_SECRET_CMD)
    : ['security', 'find-generic-password', '-a', feishu.keychainAccount, '-s', feishu.keychainService, '-w']
  const res = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 10_000 })
  const secret = res.status === 0 ? res.stdout.trim() : ''
  return secret || null
}

async function main() {
  const env = process.env
  if (env.CINDY_SCRIPT_PROTOCOL !== '1' && env.XDT_MAKER_SCRIPT_PROTOCOL !== '1') {
    process.stderr.write('必须在 Cindy script 调度下运行，拒绝空跑\n')
    process.exitCode = 1
    return
  }
  const channel = createChannel()
  const context = await channel.start()
  const stateDir = selectStateDir(env)
  createStore(stateDir) // 确保目录存在

  const round = runTickOnce(env)
  const { alerts } = recordRound(stateDir, round)
  const lines = [...toEventLines(round.result?.events), ...toEventLines(alerts)]
  const summary = { ok: round.ok, shadow: round.result?.shadow ?? null, disabled: round.result?.disabled ?? false, events: round.result?.events?.length ?? 0, wake: lines.length, error: round.error ?? null }

  // CI 变红先发飞书（#48），结果写进本轮结果和给伙伴的消息；没有红灯时不读配置、不读钥匙串、不发请求
  const red = lines.map((line) => JSON.parse(line)).filter((ev) => RED_EVENT_TYPES.has(ev.type))
  const feishu = red.length ? await notifyCiRed({ env, red }) : null
  if (feishu) summary.feishu = feishu

  if (lines.length > 0) {
    const target = env.PRAISE_MERGE_PARTNER_SESSION || context.targetSessionId || context.target_session_id
    if (!target) throw new Error('不知道该叫醒哪个伙伴：没设 PRAISE_MERGE_PARTNER_SESSION，宿主 context 里也没有绑定任务')
    const receipt = await channel.call('sessions.dispatch', { target_session_id: target, message: toPartnerMessage(lines, { shadow: summary.shadow, feishu }) })
    summary.dispatched = receipt?.target_session_id === target
  }
  channel.complete(JSON.stringify(summary))
  if (!round.ok) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`cindy-tick: ${err.message}\n`)
    process.exitCode = 1
  })
}
