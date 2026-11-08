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
  assert.deepEqual(policy.repos['xindong/mivo-canvas-plugin'].autoIntake, { authors: ['praise-qa[bot]'], label: 'review:merge-ready', base: 'main', labelActors: ['praisebuild[bot]', 'PraiseZhu'] })
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const status = readme.slice(readme.indexOf('**现状（2026-11-08 起'), readme.indexOf('## 命令'))
  for (const phrase of ['伙伴只合 Mivo', 'Cindy 脚本调度 `12fe125a`', '每 1 分钟', '个人仓车道的代码', '「自动接单」']) assert.ok(status.includes(phrase), phrase)
  assert.ok(!readme.includes('11 个个人仓都是'), 'README 不再说 11 个个人仓都是')
  const intake = readme.slice(readme.indexOf('## 自动接单'), readme.indexOf('## 安全开关'))
  const rule = JSON.parse(`{${intake.match(/```json\n([\s\S]*?)\n```/)[1]}}`).auto_intake
  assert.deepEqual(toPolicy({ repos: { 'xindong/mivo-canvas-plugin': { lane: 'mivo', required_checks: ['verify'], auto_intake: rule } } }).repos['xindong/mivo-canvas-plugin'].autoIntake, policy.repos['xindong/mivo-canvas-plugin'].autoIntake)
  for (const phrase of ['open、非 Draft、作者在 `auto_intake.authors` 里、base 等于 `auto_intake.base`、带 `auto_intake.label` 标签', '只能写在 `lane: mivo` 的条目上', '`expired` 的重新接单', '只有 head 变了', '`auto_intake_label_missing`', '`auto-intake`']) assert.ok(intake.includes(phrase), phrase)
})

test('#30 SC8 SC9 README 写明标签操作者规则和接单出错不中断本轮', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const intake = readme.slice(readme.indexOf('## 自动接单'), readme.indexOf('## 安全开关'))
  for (const phrase of ['**标签必须是审查机挂的**', '`GET /repos/{repo}/issues/{n}/events`', '最近一次 `labeled` 事件', '`label_actors`', '`praisebuild[bot]`', '读不到、分页没读完、没有 `labeled` 事件、操作者不在名单，都按不满足', '`auto_intake_label_actor`', '**接单出错不中断本轮**', '`auto_intake_failed`', '`auto_intake_recovered`']) assert.ok(intake.includes(phrase), phrase)
})
