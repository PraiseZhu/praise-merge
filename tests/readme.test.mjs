// README 里的请求示例必须是一份能通过校验的真实请求，示例配置必须能被解析
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toValidatedRequest } from '../src/request.mjs'
import { toPolicy, toAppConfig } from '../src/policy.mjs'

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
