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
  const mivo = ops.slice(ops.indexOf('### Mivo 接受的目标分支'), ops.indexOf('### bot PR 自动接单'))
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

test('#26 手册写明 main 和集成分支同一条规则：CLEAN 直接合，只有 BEHIND 才 update-branch', () => {
  const mivo = ops.slice(ops.indexOf('### Mivo 接受的目标分支'), ops.indexOf('### bot PR 自动接单'))
  const row = mivo.split('\n').find((l) => l.startsWith('| 落后时 |'))
  assert.ok(row, '表里有「落后时」一行')
  for (const phrase of ['`CLEAN`', '`BEHIND`', '`update-branch`', '同一条规则']) assert.ok(row.includes(phrase), phrase)
})

test('#24 手册写明授权不绑定改动、GPT 单审和 e2e 绑定改动，原因名和门禁一致', () => {
  const part = ops.slice(ops.indexOf('### 授权和改动'), ops.indexOf('### 哪些仓能接单'))
  for (const phrase of ['授权不绑定改动，GPT 单审和 e2e 绑定改动', '`gpt-review: patch_changed`', '`e2e: patch_changed`', '超过 7 天', '`patch:<patch-id> pr:<owner/repo>#<号> by:<会话 id>`', '`authorization: pr_mismatch`', '`authorization: patch_changed`']) assert.ok(part.includes(phrase), phrase)
})

test('#30 SC6 手册写明伙伴只合 Mivo、bot PR 自动接单的条件和不重复接单规则、巡检入口是脚本调度 12fe125a', () => {
  for (const phrase of ['**伙伴只合 Mivo**', '**巡检入口是 Cindy 脚本调度 `12fe125a-3088-45aa-a021-d9420d30e698`**', '每 1 分钟', '「合并引擎巡检」已停用']) assert.ok(ops.includes(phrase), phrase)
  assert.ok(!ops.includes('现在不用'), '删掉「cindy-tick.mjs 现在不用」')
  const intake = ops.slice(ops.indexOf('### bot PR 自动接单'), ops.indexOf('### 巡检发现事件时'))
  for (const phrase of ['open、非 Draft、作者在 `auto_intake.authors` 里、base 等于 `auto_intake.base`、带 `auto_intake.label` 标签', '已有这个 PR 的未完成条目就跳过', '已 merged / closed 的跳过', 'expired 的重新接单', 'dequeued / rejected / blocked_by_dependency 的只有 head 变了才重新接单', '`auto_intake_label_missing`']) assert.ok(intake.includes(phrase), phrase)
  const events = ops.slice(ops.indexOf('### 巡检发现事件时'), ops.indexOf('### 合入后通知发起合并的会话'))
  assert.ok(events.split('\n').some((l) => l.startsWith('| `auto_intake` |')), '事件表有 auto_intake 一行')
})
