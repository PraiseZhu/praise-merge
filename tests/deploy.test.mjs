// #5：doctor、deploy.sh、事件、心跳、Cindy script 入口
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { runDoctor, EXPECTED_PERMISSIONS } from '../scripts/doctor.mjs'
import { toEventLines } from '../src/events.mjs'
import { recordRound } from '../src/heartbeat.mjs'
import { makeTempDir, makePrivateKey } from './helpers/fake-github.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SECRET_SHAPES = [/BEGIN [A-Z ]*PRIVATE KEY/, /ghs_[A-Za-z0-9]{20}/, /eyJ[A-Za-z0-9_-]{10,}\./]

// SC1 doctor ------------------------------------------------------------------------------------
function doctorFixture({ keyMode = 0o600, keyUnderSynced = false, appId = 5642127 } = {}) {
  const home = makeTempDir()
  const configDir = makeTempDir()
  const keyDir = keyUnderSynced ? join(home, 'AI-Agent', 'keys') : join(home, '.config', 'apps')
  mkdirSync(keyDir, { recursive: true })
  const keyPath = join(keyDir, 'k.pem')
  writeFileSync(keyPath, makePrivateKey())
  chmodSync(keyPath, keyMode)
  writeFileSync(join(configDir, 'app.json'), JSON.stringify({ app_id: appId, installations: { PraiseZhu: 11 }, key_path: keyPath }))
  writeFileSync(join(configDir, 'policy.json'), JSON.stringify({ repos: { 'PraiseZhu/demo': { lane: 'personal', required_checks: ['verify'] } } }))
  return { home, configDir }
}

// 假 GitHub：App ID 不是 5642127 时换令牌返回 401（GitHub 对签名对不上的 JWT 就是这样）
const doctorFetch = async (url, init = {}) => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (url.endsWith('/access_tokens')) {
    const payload = JSON.parse(Buffer.from(init.headers.Authorization.split(' ')[1].split('.')[1], 'base64url').toString())
    if (payload.iss !== '5642127') return json(401, { message: 'A JSON web token could not be decoded' })
    return json(201, { token: 'test-installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: EXPECTED_PERMISSIONS })
  }
  if (url.includes('/installation/repositories')) return json(200, { repositories: [{ full_name: 'PraiseZhu/demo' }] })
  return json(404, { message: 'Not Found' })
}

const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name)

test('SC1 doctor：正常配置全部 pass，输出里没有私钥或令牌', async () => {
  const f = doctorFixture()
  const results = await runDoctor({ configDir: f.configDir, home: f.home, fetchImpl: doctorFetch })
  assert.deepEqual(failed(results), [])
  const text = JSON.stringify(results)
  for (const re of SECRET_SHAPES) assert.doesNotMatch(text, re)
  assert.doesNotMatch(text, /test-installation-token/)
})

for (const [name, opts, expected] of [
  ['私钥权限 644', { keyMode: 0o644 }, ['key_mode_600']],
  ['私钥在 ~/AI-Agent 下', { keyUnderSynced: true }, ['key_not_synced']],
  ['App ID 错误', { appId: 1 }, ['installation_praisezhu']],
]) {
  test(`SC1 doctor 报 fail：${name}`, async () => {
    const f = doctorFixture(opts)
    const results = await runDoctor({ configDir: f.configDir, home: f.home, fetchImpl: doctorFetch })
    assert.deepEqual(failed(results), expected)
    for (const re of SECRET_SHAPES) assert.doesNotMatch(JSON.stringify(results), re)
  })
}

test('SC1 doctor 的命令行在有 fail 时以非 0 退出', () => {
  const f = doctorFixture({ keyMode: 0o644 })
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'doctor.mjs'), '--config', f.configDir], { encoding: 'utf8', env: { ...process.env, HOME: f.home } })
  assert.notEqual(res.status, 0)
  assert.match(res.stdout, /^fail {2}key_mode_600/m)
})

// SC2 deploy.sh ---------------------------------------------------------------------------------
test('SC2 deploy.sh：不带 --apply 不写任何文件；带 --apply 不覆盖运行目录的配置、状态和停止开关', () => {
  const target = join(makeTempDir(), 'runtime')
  const dry = spawnSync('bash', [join(root, 'scripts', 'deploy.sh'), '--target', target], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.equal(existsSync(target), false)

  mkdirSync(join(target, 'config'), { recursive: true })
  mkdirSync(join(target, 'state'), { recursive: true })
  writeFileSync(join(target, 'config', 'app.json'), '{"real":true}')
  writeFileSync(join(target, 'config', 'policy.json'), '{"real":true}')
  writeFileSync(join(target, 'state', 'queue.json'), '{"items":[]}')
  writeFileSync(join(target, 'DISABLED'), '')
  writeFileSync(join(target, 'stale.txt'), 'old code')

  const dryAgain = spawnSync('bash', [join(root, 'scripts', 'deploy.sh'), '--target', target], { encoding: 'utf8' })
  assert.equal(dryAgain.status, 0, dryAgain.stderr)
  assert.equal(existsSync(join(target, 'bin')), false)

  const res = spawnSync('bash', [join(root, 'scripts', 'deploy.sh'), '--target', target, '--apply'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.ok(existsSync(join(target, 'bin', 'praise-merge')))
  assert.equal(readFileSync(join(target, 'config', 'app.json'), 'utf8'), '{"real":true}')
  assert.equal(readFileSync(join(target, 'config', 'policy.json'), 'utf8'), '{"real":true}')
  assert.equal(readFileSync(join(target, 'state', 'queue.json'), 'utf8'), '{"items":[]}')
  assert.ok(existsSync(join(target, 'DISABLED')))
  assert.equal(existsSync(join(target, 'stale.txt')), false)
  assert.equal(existsSync(join(target, '.git')), false)
  assert.match(readFileSync(join(target, 'VERSION'), 'utf8'), /^[0-9a-f]{40}|unknown/)
})

test('SC2 deploy.sh 拒绝把运行目录放在 ~/AI-Agent 下', () => {
  const home = makeTempDir()
  const res = spawnSync('bash', [join(root, 'scripts', 'deploy.sh'), '--target', join(home, 'AI-Agent', 'x'), '--apply'], { encoding: 'utf8', env: { ...process.env, HOME: home } })
  assert.equal(res.status, 2)
  assert.equal(existsSync(join(home, 'AI-Agent')), false)
})

// SC3 事件 --------------------------------------------------------------------------------------
test('SC3 没有事件时输出为空；影子记录不叫醒；要人看的事件一行一个，同一 PR 同类事件只留一条', () => {
  assert.deepEqual(toEventLines([]), [])
  assert.deepEqual(toEventLines([{ type: 'would_merge', repo: 'r', pr: 1, head: 'h' }, { type: 'would_enqueue', repo: 'r', pr: 2 }]), [])
  const lines = toEventLines([
    { type: 'merged', repo: 'praisezhu/demo', pr: 1, head: 'h', mergeSha: 'm' },
    { type: 'merged', repo: 'praisezhu/demo', pr: 1, reason: 'merged m' },
    { type: 'expired', repo: 'praisezhu/demo', pr: 2, reason: '授权超过 7 天' },
  ])
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [
    { type: 'merged', repo: 'praisezhu/demo', pr: 1, head: 'h' },
    { type: 'expired', repo: 'praisezhu/demo', pr: 2, reason: '授权超过 7 天' },
  ])
})

// SC4 心跳 --------------------------------------------------------------------------------------
test('SC4 连续 3 轮失败、或距上一轮超过 10 分钟，产生 health_alert', () => {
  const dir = makeTempDir()
  const t0 = Date.parse('2026-11-06T12:00:00Z')
  assert.deepEqual(recordRound(dir, { ok: false, error: 'x' }, t0).alerts, [])
  assert.deepEqual(recordRound(dir, { ok: false, error: 'x' }, t0 + 60_000).alerts, [])
  const third = recordRound(dir, { ok: false, error: 'boom' }, t0 + 120_000)
  assert.equal(third.heartbeat.consecutiveFailures, 3)
  assert.match(third.alerts[0].reason, /consecutive_failures: 连续 3 轮失败，最近一次：boom/)
  assert.equal(recordRound(dir, { ok: true }, t0 + 180_000).heartbeat.consecutiveFailures, 0)
  const gap = recordRound(dir, { ok: true }, t0 + 180_000 + 11 * 60_000)
  assert.match(gap.alerts[0].reason, /heartbeat_gap: 距上一轮 11 分钟/)
  assert.deepEqual(recordRound(dir, { ok: true }, t0 + 180_000 + 12 * 60_000).alerts, [])
})

// Cindy script 入口 -----------------------------------------------------------------------------
// 扮演宿主：发 start 帧，回答 call 帧，收集脚本写出的全部帧
async function runAsHost({ tickOutput, context = {}, extraEnv = {} }) {
  const state = makeTempDir()
  const child = spawn(process.execPath, [join(root, 'scripts', 'cindy-tick.mjs')], {
    env: { ...process.env, CINDY_SCRIPT_PROTOCOL: '1', PRAISE_MERGE_STATE: state, PRAISE_MERGE_TICK_CMD: JSON.stringify([process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(tickOutput))})`]), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames = []
  child.stdin.write(`${JSON.stringify({ protocol: 'cindy-script/1', type: 'start', context })}\n`)
  for await (const line of createInterface({ input: child.stdout })) {
    const frame = JSON.parse(line)
    frames.push(frame)
    if (frame.type === 'call') child.stdin.write(`${JSON.stringify({ protocol: 'cindy-script/1', type: 'call_result', id: frame.id, ok: true, result: { target_session_id: frame.params.target_session_id } })}\n`)
    if (frame.type === 'complete') child.stdin.end()
  }
  await new Promise((resolve) => child.on('close', resolve))
  return { frames, state }
}

test('script 入口：有要人看的事件时 dispatch 给伙伴，再 complete；stdout 只有协议帧', async () => {
  const { frames, state } = await runAsHost({
    tickOutput: { shadow: false, events: [{ type: 'merged', repo: 'praisezhu/demo', pr: 1, head: 'h' }, { type: 'would_merge', repo: 'praisezhu/demo', pr: 2 }] },
    extraEnv: { PRAISE_MERGE_PARTNER_SESSION: 'dev::partner' },
  })
  assert.deepEqual(frames.map((f) => f.type), ['call', 'complete'])
  assert.ok(frames.every((f) => f.protocol === 'cindy-script/1'))
  assert.equal(frames[0].method, 'sessions.dispatch')
  assert.equal(frames[0].params.target_session_id, 'dev::partner')
  assert.match(frames[0].params.message, /^praise-merge 事件（1 条）/)
  assert.match(frames[0].params.message, /"type":"merged"/)
  assert.doesNotMatch(frames[0].params.message, /would_merge/)
  assert.deepEqual(JSON.parse(frames[1].resultText), { ok: true, shadow: false, disabled: false, events: 2, wake: 1, error: null, dispatched: true })
  assert.ok(readdirSync(state).includes('heartbeat.json'))
})

test('script 入口：没有要人看的事件时不叫醒伙伴，只 complete', async () => {
  const { frames } = await runAsHost({ tickOutput: { shadow: true, events: [{ type: 'would_merge', repo: 'r', pr: 1 }] }, context: { targetSessionId: 'dev::bound' } })
  assert.deepEqual(frames.map((f) => f.type), ['complete'])
  assert.equal(JSON.parse(frames[0].resultText).wake, 0)
})

test('script 入口：不在 Cindy script 调度下运行时拒绝空跑', () => {
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'cindy-tick.mjs')], { encoding: 'utf8', env: { ...process.env, CINDY_SCRIPT_PROTOCOL: '', XDT_MAKER_SCRIPT_PROTOCOL: '' } })
  assert.notEqual(res.status, 0)
  assert.equal(res.stdout, '')
})
