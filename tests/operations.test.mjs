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

// #40：lead 发的通知登记，手册里的示例原样抽出来跑查地址命令
const notifySection = ops.slice(ops.indexOf('### 收到「praise-merge 通知登记」'), ops.indexOf('### 授权和改动'))
const notifyExample = JSON.parse(notifySection.match(/```json\n([^`]+)```/)[1])
const MIVO = 'xindong/mivo-canvas-plugin'

test('#40 SC1 手册写明通知登记的格式和处理：存进 requests/、不执行 enqueue、不改队列', () => {
  assert.equal(notifyExample.schema, 'praise-merge/notify@1')
  assert.deepEqual(notifyExample.prs, [{ repo: MIVO, number: 2017 }])
  assert.match(notifyExample.notify_session, /::/)
  for (const phrase of ['第一行是 `praise-merge 通知登记`', '`~/.local/state/praise-merge/requests/<时间戳>-notify.json`', '不执行 `enqueue`，不改队列']) assert.ok(notifySection.includes(phrase), phrase)
})

test('#40 SC2 只有通知登记时查地址命令输出登记的地址；之后来一份不带地址的合并请求就输出为空', () => {
  const reg = { ...notifyExample, notify_session: `${DEV}::lead` }
  assert.equal(lookup([reg], MIVO, 2017), `${DEV}::lead`)
  assert.equal(lookup([reg, { prs: [{ repo: MIVO, number: 2017 }] }], MIVO, 2017), '')
  assert.equal(lookup([reg], MIVO, 2018), '', '别的 PR 查不到这份登记')
})

test('#40 SC3 手册不再写自动接单的条目一律不通知，地址来自合并请求或通知登记', () => {
  const intake = ops.slice(ops.indexOf('### bot PR 自动接单'), ops.indexOf('### 本人 PR 按正文合并顺序自动接单'))
  assert.ok(intake.includes('发过「praise-merge 通知登记」的，合入后按登记的地址通知 lead'))
  for (const phrase of ['合并请求或通知登记里的 `notify_session`', '只看最新一份包含这个 PR 的请求或登记']) assert.ok(section.includes(phrase), phrase)
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
  for (const phrase of ['open、非 Draft、作者在 `auto_intake.authors` 里、目标分支在 `auto_intake.base` 里、带 `auto_intake.label` 标签', '合进集成分支的也接', '"authors": ["praise-qa[bot]", "PraiseZhu", "huangkexin-commits", "shaoshenze-rgb"]', '已有这个 PR 的未完成条目就跳过', '已 merged / closed 的跳过', 'expired 的重新接单', 'dequeued / rejected / blocked_by_dependency 的只有 head 变了才重新接单', '`auto_intake_label_missing`']) assert.ok(intake.includes(phrase), phrase)
  const events = ops.slice(ops.indexOf('### 巡检发现事件时'), ops.indexOf('### 合入后通知发起合并的会话'))
  assert.ok(events.split('\n').some((l) => l.startsWith('| `auto_intake` |')), '事件表有 auto_intake 一行')
})

test('#30 SC8 SC9 手册写明标签操作者规则、接单出错不中断本轮，事件表有失败与恢复', () => {
  const intake = ops.slice(ops.indexOf('### bot PR 自动接单'), ops.indexOf('### 巡检发现事件时'))
  for (const phrase of ['**标签必须是审查机挂的**', '`label_actors`', '`praisebuild[bot]`', '读不到、分页没读完、不在名单都按不满足', '`auto_intake_label_actor`', '**接单出错不中断本轮**', '照常处理已有队列', '已在队列的自动接单条目处理时读不到标签操作者', '按 PR 号排序']) assert.ok(intake.includes(phrase), phrase)
  const rows = ops.slice(ops.indexOf('### 巡检发现事件时'), ops.indexOf('### 合入后通知发起合并的会话')).split('\n')
  for (const type of ['auto_intake_failed', 'auto_intake_recovered']) assert.ok(rows.some((l) => l.startsWith(`| \`${type}\` |`)), type)
})

test('#32 SC8 手册写明目标分支全绿才合、暂停与恢复时机、已知代价、前置检查目录部署不删，事件表写明 main_checks_not_green 怎么回', () => {
  const part = ops.slice(ops.indexOf('### 目标分支全绿才合'), ops.indexOf('### bot PR 自动接单'))
  for (const phrase of [
    '**全绿才合**', 'main 和 `integration/*`', '按写入的 App 和名字分组取最新一次（id 最大', '别的 App 的成功盖不掉这个 App 的失败', '结论是 `success`、`skipped` 或 `neutral`', 'commit status 有条目时，合并状态必须是 `success`',
    '一个 push 触发的 check run 都没有也不算绿', '读取失败或读不全按不绿处理', '`main_checks_not_green: <提交> <检查名=状态>`', '最多列 10 个', '原因变了才再发 `lane_paused`',
    '**恢复**', '下一轮巡检就恢复', '最多约 1 分钟', '`lane_resumed`', '`base_checks_not_green: <分支> <提交> <检查名=状态>`', '不暂停车道',
    '**已知代价**', '包括非必需检查', '外部故障', '伙伴会收到 `lane_paused`', '`scripts/schedule-checks/token.mjs`',
  ]) assert.ok(part.includes(phrase), phrase)
  const row = ops.split('\n').find((l) => l.startsWith('| 分支头 CI |'))
  for (const phrase of ['全部检查都绿', '`base_checks_not_green`', '同一条规则']) assert.ok(row.includes(phrase), phrase)
  assert.ok(ops.split('\n').some((l) => l.startsWith('| `lane_paused` / `lane_resumed` |') && l.includes('`main_checks_not_green`') && l.includes('自动恢复')), '事件表写明 main_checks_not_green 怎么回')
  assert.ok(ops.includes('以及宿主管理的调度前置检查目录 `scripts/schedule-checks/`'), '部署一节写明不碰 scripts/schedule-checks/')
})

test('#36 SC6 手册写明只看 push 触发的检查、哪些来源不算、为什么，以及非 push 检查红了不挡合并', () => {
  const part = ops.slice(ops.indexOf('### 目标分支全绿才合'), ops.indexOf('### bot PR 自动接单'))
  for (const phrase of [
    '**只看 push 触发的检查**（2026-11-08 起，PraiseZhu/praise-merge#36）', '只有 `push` 算', '事件是 `dynamic`，只算名字是「Push on <分支>」', '定时的「Scheduled」不算',
    '`workflow_dispatch`（如审查机审别的 PR 跑的 `review-pr`）、`schedule`、`issue_comment`、`workflow_run`（如 PR gate rerun）、`issues` 触发的检查',
    '跟 main 本身无关，不算', '78 个工作流运行只有 3 个是 push', '「main 红了就停」', '别的 App（不是 GitHub Actions）写的检查照旧都算',
    '找不到所属 workflow run 的 Actions 检查不知道来源，按不绿', '检查先按来源筛', 'check run 和 workflow run 都读完全部分页', '非 push 触发的检查红了不挡合并',
  ]) assert.ok(part.includes(phrase), phrase)
})
