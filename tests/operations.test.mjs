// docs/operations.md 里给伙伴照抄执行的命令，由测试原样抽出来跑
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTempDir } from './helpers/fake-github.mjs'
import { MIVO_ACCEPTED_BASES, MIVO_INTEGRATION_MERGE_METHOD, MIVO_INTEGRATION_REVIEW_CHECK, isMivoBase } from '../src/policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ops = readFileSync(join(root, 'docs/operations.md'), 'utf8')
const section = ops.slice(ops.indexOf('### 合入后通知发起合并的会话'))
const script = section.match(/node -e '([^']+)' <owner\/repo> <号>/)[1]

const DEV = 'a'.repeat(64)
function lookup(requests, repo = 'PraiseZhu/project-keel', number = 12) {
  const state = makeTempDir()
  const dir = join(state, 'requests')
  mkdirSync(dir)
  requests.forEach((req, i) => {
    const file = join(dir, `r${i}.json`)
    writeFileSync(file, JSON.stringify(req))
    const t = new Date(Date.UTC(2026, 10, 7, 0, i)) // 后写的更新
    utimesSync(file, t, t)
  })
  return execFileSync(process.execPath, ['-e', script, repo, String(number)], { env: { ...process.env, PRAISE_MERGE_STATE: state }, encoding: 'utf8' }).trim()
}
const req = (notify, number = 12) => ({ prs: [{ repo: 'PraiseZhu/project-keel', number }], ...(notify ? { notify_session: `${DEV}::${notify}` } : {}) })

test('#18 最新一份请求带地址：输出最新地址', () => {
  assert.equal(lookup([req('old'), req('new')]), `${DEV}::new`)
})

test('#18 最新一份请求不带地址：输出为空，不回退用旧请求的地址', () => {
  assert.equal(lookup([req('old'), req(null)]), '')
})

test('#18 没有包含这个 PR 的请求：输出为空；别的 PR 的地址不会串过来', () => {
  assert.equal(lookup([req('other', 99)]), '')
})

test('#18 仓名大小写不同也能匹配', () => {
  assert.equal(lookup([req('s1')], 'praisezhu/PROJECT-KEEL'), `${DEV}::s1`)
})

test('#20 手册写明 Mivo 接受的目标分支和集成分支的合并条件，和代码一致', () => {
  const mivo = ops.slice(ops.indexOf('### Mivo 接受的目标分支'), ops.indexOf('### 例行任务发现事件时'))
  assert.ok(mivo.includes(`base 期望 ${MIVO_ACCEPTED_BASES}，实际 <分支>`))
  for (const ref of ['main', 'integration/cindy-media-phase2']) assert.ok(isMivoBase(ref) && mivo.includes(`\`${ref}\``), ref)
  for (const ref of ['release/x', 'integration/a/b']) assert.ok(!isMivoBase(ref) && mivo.includes(`\`${ref}\``), ref)
  assert.ok(mivo.includes(`\`${MIVO_INTEGRATION_REVIEW_CHECK}\``))
  assert.match(mivo, new RegExp(`\\| 合并 \\| squash.*\\| ${MIVO_INTEGRATION_MERGE_METHOD}（`))
  assert.ok(mivo.includes('merged_on_moved_base'))
})

test('#22 手册写明默认条目的优先级、"all" 的含义和无 CI 时的等待原因，和代码一致', () => {
  const part = ops.slice(ops.indexOf('### 哪些仓能接单'), ops.indexOf('### Mivo 接受的目标分支'))
  for (const phrase of ['`PraiseZhu/*`', '逐仓条目优先', 'repo_not_in_policy', 'repo_excluded', '`"all"`', '`praise-merge/*` 证据', 'head 上还没有任何检查，等 CI 出现']) assert.ok(part.includes(phrase), phrase)
})
