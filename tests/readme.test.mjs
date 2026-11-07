// README 里的请求示例必须是一份能通过校验的真实请求，示例配置必须能被解析
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toValidatedRequest } from '../src/request.mjs'
import { ALL_CHECKS, toPolicy, toAppConfig, selectRepoPolicy } from '../src/policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('README 的合并请求示例按示例 policy 校验通过，依赖关系被保留', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const json = readme.match(/```json\n([\s\S]*?)\n```/)[1]
  const policy = toPolicy(JSON.parse(readFileSync(join(root, 'config/policy.example.json'), 'utf8')))
  const result = toValidatedRequest(JSON.parse(json), { policy })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rejected, [])
  assert.deepEqual(result.prs.map((p) => [p.id, p.after]), [
    ['praisezhu/project-keel#12', []],
    ['praisezhu/project-keel#13', ['praisezhu/project-keel#12']],
  ])
})

test('app 示例配置能解析，影子模式默认开', () => {
  const app = toAppConfig(JSON.parse(readFileSync(join(root, 'config/app.example.json'), 'utf8')))
  assert.equal(app.appId, 5642127)
  assert.equal(app.shadow, true)
  assert.equal(toAppConfig({ ...JSON.parse(readFileSync(join(root, 'config/app.example.json'), 'utf8')), shadow: undefined }).shadow, true)
})

test('#22 示例 policy 的 PraiseZhu/* 默认条目能解析；README 写明写法、"all" 的含义和优先级', () => {
  const policy = toPolicy(JSON.parse(readFileSync(join(root, 'config/policy.example.json'), 'utf8')))
  const fallback = selectRepoPolicy(policy, 'PraiseZhu/any-new-repo')
  assert.deepEqual([fallback.name, fallback.lane, fallback.requiredChecks, fallback.e2e], ['PraiseZhu/*', 'personal', ALL_CHECKS, 'required'])
  assert.deepEqual(selectRepoPolicy(policy, 'PraiseZhu/project-keel').requiredChecks, ['verify'])
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('## policy：逐仓条目与 `PraiseZhu/*` 默认条目'), readme.indexOf('## 审查证据'))
  const example = JSON.parse(`{${section.match(/```json\n([\s\S]*?)\n```/)[1]}}`)
  assert.equal(toPolicy({ repos: example }).defaults.praisezhu.requiredChecks, ALL_CHECKS)
  for (const phrase of ['逐仓条目优先', `"required_checks": "${ALL_CHECKS}"`, '`praise-merge/*` 证据', '满 10 分钟', 'repo_not_in_policy', 'repo_excluded']) assert.ok(section.includes(phrase), phrase)
})

test('#24 README 写明授权不绑定改动、GPT 单审和 e2e 绑定改动，不再说授权随 patch-id 失效', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('## 审查证据'), readme.indexOf('## Mivo 车道'))
  assert.ok(section.includes('授权不绑定改动，GPT 单审和 e2e 绑定改动'))
  assert.ok(section.includes('GPT 单审和 e2e 的 patch-id 等于当前 PR 的 patch-id'))
  assert.ok(!section.includes('授权也跟着失效'))
})
