// README 里的请求示例必须是一份能通过校验的真实请求，示例配置必须能被解析
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toValidatedRequest } from '../src/request.mjs'
import { ALL_CHECKS, toPolicy, toAppConfig, selectRepoPolicy } from '../src/policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('README 的合并请求示例按示例 policy（只有 Mivo）校验通过，依赖关系被保留', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const json = readme.match(/```json\n([\s\S]*?)\n```/)[1]
  const policy = toPolicy(JSON.parse(readFileSync(join(root, 'config/policy.example.json'), 'utf8')))
  const result = toValidatedRequest(JSON.parse(json), { policy })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rejected, [])
  assert.deepEqual(result.prs.map((p) => [p.id, p.after]), [
    ['xindong/mivo-canvas-plugin#12', []],
    ['xindong/mivo-canvas-plugin#13', ['xindong/mivo-canvas-plugin#12']],
  ])
})

test('app 示例配置能解析，影子模式默认开', () => {
  const app = toAppConfig(JSON.parse(readFileSync(join(root, 'config/app.example.json'), 'utf8')))
  assert.equal(app.appId, 5642127)
  assert.equal(app.shadow, true)
  assert.equal(toAppConfig({ ...JSON.parse(readFileSync(join(root, 'config/app.example.json'), 'utf8')), shadow: undefined }).shadow, true)
})

test('#22 README 里的 PraiseZhu/* 默认条目能解析；README 写明写法、"all" 的含义和优先级', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('## policy：逐仓条目与 `PraiseZhu/*` 默认条目'), readme.indexOf('## 审查证据'))
  const example = JSON.parse(`{${section.match(/```json\n([\s\S]*?)\n```/)[1]}}`)
  const fallback = selectRepoPolicy(toPolicy({ repos: example }), 'PraiseZhu/any-new-repo')
  assert.deepEqual([fallback.name, fallback.lane, fallback.requiredChecks, fallback.e2e], ['PraiseZhu/*', 'personal', ALL_CHECKS, 'required'])
  for (const phrase of ['逐仓条目优先', `"required_checks": "${ALL_CHECKS}"`, '`praise-merge/*` 证据', '满 10 分钟', 'repo_not_in_policy', 'repo_excluded']) assert.ok(section.includes(phrase), phrase)
})

test('#26 README 写明「能直接合就直接合」：个人仓和 Mivo 只在 GitHub 要求同步时才追分支，并写明已知代价', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const personal = readme.slice(readme.indexOf('## 个人仓门禁'), readme.indexOf('## policy：逐仓条目与 `PraiseZhu/*` 默认条目'))
  for (const phrase of ['能直接合就直接合', '`mergeable_state=clean`', '`mergeable_state=behind`', '已知代价']) assert.ok(personal.includes(phrase), phrase)
  assert.ok(!personal.includes('`up_to_date`'), '个人仓门禁表里不再有 up_to_date')
  const mivo = readme.slice(readme.indexOf('## Mivo 车道'), readme.indexOf('## 安全开关'))
  for (const phrase of ['能直接合就直接合', '`CLEAN`', '`BEHIND`', '已知代价', 'merged_on_moved_main']) assert.ok(mivo.includes(phrase), phrase)
  assert.ok(!mivo.includes('合并前 PR 必须不落后 main'))
})

test('#24 README 写明授权不绑定改动、GPT 单审和 e2e 绑定改动，不再说授权随 patch-id 失效', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('## 审查证据'), readme.indexOf('## Mivo 车道'))
  assert.ok(section.includes('授权不绑定改动，GPT 单审和 e2e 绑定改动'))
  assert.ok(section.includes('GPT 单审和 e2e 的 patch-id 等于当前 PR 的 patch-id'))
  assert.ok(!section.includes('授权也跟着失效'))
  for (const phrase of ['`patch:<patch-id> pr:<owner/repo>#<号> by:<会话 id>`', '只截短 by', '授权只对写明的 PR 有效', '`authorization: pr_mismatch', '旧格式授权照旧绑定 patch-id']) assert.ok(section.includes(phrase), phrase)
})

test('#30 SC6 示例 policy 只有 Mivo 且带 auto_intake；README 写明伙伴只合 Mivo、bot PR 自动接单条件、巡检入口', () => {
  const policy = toPolicy(JSON.parse(readFileSync(join(root, 'config/policy.example.json'), 'utf8')))
  assert.deepEqual(Object.keys(policy.repos), ['xindong/mivo-canvas-plugin'])
  assert.deepEqual(policy.defaults, {})
  assert.deepEqual(policy.repos['xindong/mivo-canvas-plugin'].autoIntake, { authors: ['praise-qa[bot]', 'PraiseZhu', 'huangkexin-commits', 'shaoshenze-rgb', 'zhanxinyi-lab'], label: 'review:merge-ready', bases: ['main', 'integration/*'], labelActors: ['praisebuild[bot]', 'PraiseZhu'], orderLineAuthors: ['PraiseZhu'] })
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const status = readme.slice(readme.indexOf('**现状（2026-11-08 起'), readme.indexOf('## 命令'))
  for (const phrase of ['伙伴只合 Mivo', 'Cindy 脚本调度 `12fe125a`', '每 1 分钟', '个人仓车道的代码', '「自动接单」']) assert.ok(status.includes(phrase), phrase)
  assert.ok(!readme.includes('11 个个人仓都是'), 'README 不再说 11 个个人仓都是')
  const intake = readme.slice(readme.indexOf('## 自动接单'), readme.indexOf('## 安全开关'))
  const rule = JSON.parse(`{${intake.match(/```json\n([\s\S]*?)\n```/)[1]}}`).auto_intake
  assert.deepEqual(toPolicy({ repos: { 'xindong/mivo-canvas-plugin': { lane: 'mivo', required_checks: ['verify'], auto_intake: rule } } }).repos['xindong/mivo-canvas-plugin'].autoIntake, policy.repos['xindong/mivo-canvas-plugin'].autoIntake)
  for (const phrase of ['open、非 Draft、作者在 `auto_intake.authors` 里、目标分支在 `auto_intake.base` 里、带 `auto_intake.label` 标签', '合进集成分支的 PR 也接', '只能写在 `lane: mivo` 的条目上', '`expired` 的重新接单', '只有 head 变了', '`auto_intake_label_missing`', '`auto-intake`']) assert.ok(intake.includes(phrase), phrase)
})

test('#30 SC8 SC9 README 写明标签操作者规则和接单出错不中断本轮', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const intake = readme.slice(readme.indexOf('## 自动接单'), readme.indexOf('## 安全开关'))
  for (const phrase of ['**标签必须是审查机挂的**', '`GET /repos/{repo}/issues/{n}/events`', '最近一次 `labeled` 事件', '`label_actors`', '`praisebuild[bot]`', '读不到、分页没读完、没有 `labeled` 事件、操作者不在名单，都按不满足', '`auto_intake_label_actor`', '**接单出错不中断本轮**', '`auto_intake_failed`', '已在队列的自动接单条目处理时读不到标签操作者', '按 PR 号排序', '`auto_intake_recovered`']) assert.ok(intake.includes(phrase), phrase)
})

test('#32 SC8 README 写明 Mivo 全绿才合：哪些结论算绿、暂停与恢复时机、集成分支同一条规则、已知代价', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const mivo = readme.slice(readme.indexOf('## Mivo 车道'), readme.indexOf('## 自动接单'))
  for (const phrase of [
    '**全绿才合**', '不只看 `ci.yml`', '按写入的 App 和名字分组取最新一次（id 最大', '别的 App 的成功盖不掉这个 App 的失败', '结论是 `success`、`skipped` 或 `neutral`', 'commit status 有条目时，合并状态必须是 `success`',
    '一个 push 触发的 check run 都没有也不算绿', '读取失败或读不全都按不绿', '`main_checks_not_green: <提交> <检查名=状态>`', '最多列 10 个', '`main_ci_not_success`',
    '不合并、不 `update-branch`、不入队', '原因变了才再发一次 `lane_paused`', '**恢复时机**', '下一轮巡检', '最多约 1 分钟', '`lane_resumed`',
    '**已知代价**', '包括非必需检查', '外部故障', '`base_checks_not_green: <分支> <提交> <检查名=状态>`', '不暂停整条车道',
  ]) assert.ok(mivo.includes(phrase), phrase)
  assert.ok(!mivo.includes('main 当前 head 的 `ci.yml` 不是 success（还在跑、失败，或还没有 run）。条件恢复后自动继续'), '旧的「只看 ci.yml」说法已改掉')
})

test('#34 README 开头链到机制总览，总览写明关键规则', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  assert.ok(readme.slice(0, readme.indexOf('## 命令')).includes('[docs/how-it-works.md](docs/how-it-works.md)'))
  const doc = readFileSync(join(root, 'docs/how-it-works.md'), 'utf8')
  for (const phrase of [
    '只合 Mivo 仓（`xindong/mivo-canvas-plugin`）',
    '你在哪个会话说「合并」，就由那个会话按 `pr-merge` skill 自己用 `gh` 合',
    'praise-qa bot 开的、指向 main 或集成分支、不是 Draft、带 `review:merge-ready` 标签的 PR',
    '`praisebuild[bot]`',
    '全部转绿后的下一轮（最多约 1 分钟）恢复',
    '一轮只合一个',
    'Cindy 脚本调度 `12fe125a`，每 1 分钟跑 `scripts/cindy-tick.mjs`，零 token',
    'main 上任何一项 push 触发的检查一直不绿',
  ]) assert.ok(doc.includes(phrase), `docs/how-it-works.md 缺少：${phrase}`)
})

test('#36 SC6 README 与机制总览写明只看 push 触发的检查、哪些来源不算、为什么；总览改正读 GitHub 失败的说法', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const mivo = readme.slice(readme.indexOf('## Mivo 车道'), readme.indexOf('## 自动接单'))
  for (const phrase of [
    '**只看 push 触发的检查**（#36）', '只有 `push` 算', '事件是 `dynamic`，只算名字是「Push on <分支>」', '定时的「Scheduled」不算',
    '`workflow_dispatch`（如审查机审别的 PR 跑的 `review-pr`）、`schedule`、`issue_comment`、`workflow_run`（如 PR gate rerun）、`issues` 触发的检查',
    '跟 main 本身无关，不算', '78 个工作流运行只有 3 个是 push', '别的 App（不是 GitHub Actions）写的检查照旧都算', '找不到所属 workflow run 的 Actions 检查不知道来源，按不绿',
    '检查先按来源筛', '定时重跑的同名 CodeQL 也盖不掉 push 那次的结果', 'check run 和 workflow run 都读完全部分页',
  ]) assert.ok(mivo.includes(phrase), phrase)
  const doc = readFileSync(join(root, 'docs/how-it-works.md'), 'utf8')
  for (const phrase of [
    'main 被 push 时跑出来的检查全绿才合', 'main 当前提交上 push 触发的检查都绿？', '只看 main 当前提交被 push 时跑出来的检查',
    '别的 PR 的审查（审查机在 main 上跑的 `review-pr`）、定时任务（如定时 CodeQL）、评论或其他工作流触发的检查', '跟 main 本身无关，不算',
    '读 main 的检查失败，按不绿暂停', '已在队列的其余 PR 照常处理', '定时 CodeQL 等非 push 触发的检查红了不挡合并',
  ]) assert.ok(doc.includes(phrase), `docs/how-it-works.md 缺少：${phrase}`)
  assert.ok(!doc.includes('读 GitHub 失败时不接单、不合并'), '删掉「读 GitHub 失败时不接单、不合并」的过宽说法')
  assert.ok(!doc.includes('main 当前提交上的全部检查'), '总览不再说看 main 上的全部检查')
})

test('#38 SC7 README、运维手册、总览写明本人 PR 按正文「合并顺序」排队', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const ops = readFileSync(join(root, 'docs/operations.md'), 'utf8')
  const doc = readFileSync(join(root, 'docs/how-it-works.md'), 'utf8')
  for (const phrase of ['`order_line_authors`', '`合并顺序：无`', '`merge_order_invalid`', '`merge_order_blocked`', '依赖不必在队列里']) assert.ok(readme.includes(phrase), `README 缺：${phrase}`)
  for (const phrase of ['本人 PR 按正文合并顺序自动接单', '`check-pr-body.sh` 会要求这一行', '| `merge_order_invalid` |', '| `merge_order_blocked` |']) assert.ok(ops.includes(phrase), `operations.md 缺：${phrase}`)
  for (const phrase of ['**你的 PR 自动接单**', '`合并顺序：…`', '伙伴不自己猜顺序']) assert.ok(doc.includes(phrase), `how-it-works.md 缺：${phrase}`)
})
