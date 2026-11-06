#!/usr/bin/env node
// 每日自检（只读）：doctor 全部 pass；运行目录 VERSION 等于 praise-merge 的 main；24 小时内要过期的授权。
// 全部正常输出 ok、退出 0；有问题逐条列出、退出 1。用法：node scripts/daily-check.mjs [--config <dir>]
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig, AUTH_TTL_MS } from '../src/policy.mjs'
import { createStore, selectStateDir, FINAL_STATUSES } from '../src/queue.mjs'
import { createClientFactory } from '../src/cli.mjs'
import { runDoctor } from './doctor.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY_MS = 24 * 60 * 60 * 1000

export function toDailyProblems({ doctorResults, version, mainSha, queue, now = Date.now() }) {
  const problems = doctorResults.filter((r) => !r.ok).map((r) => `doctor 未通过：${r.name} ${r.detail}`)
  if (!version) problems.push('运行目录没有 VERSION 文件，说不清跑的是哪个版本')
  else if (version !== mainSha) problems.push(`运行目录落后：VERSION ${version.slice(0, 7)}，main ${mainSha.slice(0, 7)}，需要重新执行 scripts/deploy.sh --apply`)
  for (const it of queue.items) {
    if (FINAL_STATUSES.has(it.status)) continue
    const expiresAt = Date.parse(it.authorizedAt) + AUTH_TTL_MS
    if (expiresAt - now <= DAY_MS) problems.push(`授权快过期：${it.id} 将在 ${new Date(expiresAt).toISOString()} 过期，当前卡在：${it.reason}`)
  }
  return problems
}

const isMain = () => process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain()) {
  const i = process.argv.indexOf('--config')
  const configDir = i >= 0 ? process.argv[i + 1] : process.env.PRAISE_MERGE_CONFIG || join(root, 'config')
  ;(async () => {
    const doctorResults = await runDoctor({ configDir })
    const { app } = readConfig(configDir)
    const main = await createClientFactory({ ...app, shadow: true })('PraiseZhu/praise-merge').request('GET', '/repos/PraiseZhu/praise-merge/commits/main')
    const versionFile = join(root, 'VERSION')
    const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null
    const problems = toDailyProblems({ doctorResults, version, mainSha: main.sha, queue: createStore(selectStateDir()).loadQueue() })
    process.stdout.write(problems.length ? `${problems.map((p) => `- ${p}`).join('\n')}\n` : 'ok\n')
    process.exitCode = problems.length ? 1 : 0
  })().catch((err) => {
    process.stderr.write(`daily-check: ${err.message}\n`)
    process.exitCode = 1
  })
}
