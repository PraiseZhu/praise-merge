// SC1：只用 App 身份。401/403 直接失败并给出方法、路径、状态码；不启动 gh，不读 GH_TOKEN / GITHUB_TOKEN。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.mjs'
import { createFakeGitHub, makeWorld, makeTempDir, makePrivateKey, writeConfig, seedItem } from './helpers/fake-github.mjs'
import { createStore } from '../src/queue.mjs'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const listSrc = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listSrc(join(dir, e.name)) : [join(dir, e.name)]))
// attest 是唯一允许用调用者本机 gh 的命令（写审查证据，不碰 App 私钥），不在本约束内
const engineFiles = () => listSrc(srcDir).filter((f) => f.endsWith('.mjs') && !/[/\\]attest[^/\\]*\.mjs$/.test(f))

test('引擎源码不引入 child_process，也不读 GH_TOKEN / GITHUB_TOKEN', () => {
  for (const file of engineFiles()) {
    const text = readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /child_process/, `${file} 引入了 child_process`)
    assert.doesNotMatch(text, /GH_TOKEN|GITHUB_TOKEN/, `${file} 读取了个人令牌环境变量`)
  }
})

async function runTickWith(status) {
  const state = makeTempDir()
  const configDir = makeTempDir()
  const keyPath = join(configDir, 'key.pem')
  writeFileSync(keyPath, makePrivateKey())
  writeConfig(configDir, { keyPath })
  seedItem(createStore(state))
  const world = makeWorld()
  const fake = createFakeGitHub(world)
  world.failWith = status
  const env = { PRAISE_MERGE_STATE: state, GH_TOKEN: 'sentinel-gh-token', GITHUB_TOKEN: 'sentinel-github-token' }
  const out = { write() {} }
  const err = await main(['tick', '--config', configDir], { env, fetchImpl: fake.fetchImpl, stdout: out }).then(() => null, (e) => e)
  return { err, fake }
}

for (const status of [401, 403]) {
  test(`App 请求返回 ${status} 时 tick 失败，错误可诊断，且没用个人令牌`, async () => {
    const { err, fake } = await runTickWith(status)
    assert.ok(err, '应当抛错')
    assert.match(err.message, new RegExp(`POST /app/installations/2/access_tokens -> ${status}`))
    assert.ok(fake.calls.length > 0)
    for (const call of fake.calls) assert.doesNotMatch(call.auth ?? '', /sentinel/)
  })
}

test('bin 入口出错时以非 0 退出', async () => {
  const { spawnSync } = await import('node:child_process')
  const state = makeTempDir()
  mkdirSync(join(state, 'logs'), { recursive: true })
  const bin = join(srcDir, '..', 'bin', 'praise-merge')
  const res = spawnSync(process.execPath, [bin, 'tick', '--config', makeTempDir()], { env: { ...process.env, PRAISE_MERGE_STATE: state }, encoding: 'utf8' })
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /praise-merge: /)
})
