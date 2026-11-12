// #48：CI 变红时巡检脚本用飞书「Mivo」机器人私聊用户。发送模块、app.json 的 feishu 段、脚本入口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendFeishuTexts, toCiRedText } from '../src/feishu.mjs'
import { toAppConfig, toFeishuConfig } from '../src/policy.mjs'
import { makeTempDir } from './helpers/fake-github.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EMAIL = 'someone@example.invalid'
const SECRET = 'test-app-secret-value'
const MIVO = 'xindong/mivo-canvas-plugin'
const MAIN_RED = { type: 'main_ci_red', repo: MIVO, pr: null, branch: 'main', reason: 'main aaaaaaaa CI=failure', head: 'a'.repeat(40) }
const INT_RED = { type: 'integration_ci_red', repo: MIVO, pr: null, branch: 'integration/x', reason: 'integration/x 99999999 Windows plugin smoke=failure（在用的 PR：#1、#2）', head: '9'.repeat(40) }

// 假飞书：按路径回答，记下每个请求；answers 可覆盖某一步的返回
function fakeFeishu(answers = {}) {
  const calls = []
  const reply = {
    token: { code: 0, tenant_access_token: 'tok' },
    lookup: { code: 0, data: { user_list: [{ user_id: 'ou_x' }] } },
    send: { code: 0 },
    ...answers,
  }
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    calls.push({ path, body, auth: init.headers.Authorization ?? null })
    if (reply.hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const data = path.endsWith('/tenant_access_token/internal') ? reply.token : path.endsWith('/batch_get_id') ? reply.lookup : reply.send
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchFn, calls }
}

// SC9

test('#48 SC9 取 token → 按邮箱查 open_id → 每条文本各发一条私聊；token 和查询只做一次', async () => {
  const { fetchFn, calls } = fakeFeishu()
  const results = await sendFeishuTexts({ fetchFn, apiBase: 'https://feishu.test', appId: 'cli_x', appSecret: SECRET, email: EMAIL, texts: ['一', '二'] })
  assert.deepEqual(results, [{ status: 'sent' }, { status: 'sent' }])
  assert.deepEqual(calls.map((c) => c.path), ['/auth/v3/tenant_access_token/internal', '/contact/v3/users/batch_get_id', '/im/v1/messages', '/im/v1/messages'])
  assert.deepEqual(calls[0].body, { app_id: 'cli_x', app_secret: SECRET })
  assert.deepEqual(calls[1].body, { emails: [EMAIL] })
  assert.equal(calls[1].auth, 'Bearer tok')
  assert.deepEqual(calls[2].body, { receive_id: 'ou_x', msg_type: 'text', content: JSON.stringify({ text: '一' }) })
})

test('#48 SC9 各种失败都给固定原因码，返回值里没有邮箱和密钥', async () => {
  const cases = [
    ['读不到密钥', {}, null, 'no-credential', 0],
    ['取 token 失败', { token: { code: 10003 } }, SECRET, 'token-10003', 1],
    ['查询失败', { lookup: { code: 99991672 } }, SECRET, 'lookup-99991672', 2],
    ['查不到人', { lookup: { code: 0, data: { user_list: [{}] } } }, SECRET, 'feishu-user-not-found', 2],
    ['发送失败', { send: { code: 230001 } }, SECRET, 'send-230001', 3],
  ]
  for (const [name, answers, appSecret, code, requests] of cases) {
    const { fetchFn, calls } = fakeFeishu(answers)
    const results = await sendFeishuTexts({ fetchFn, appId: 'cli_x', appSecret, email: EMAIL, texts: ['正文'] })
    assert.deepEqual(results, [{ status: 'failed', code }], name)
    assert.equal(calls.length, requests, `${name}：请求数`)
    assert.ok(!JSON.stringify(results).includes(EMAIL) && !JSON.stringify(results).includes(SECRET), name)
  }
})

test('#48 SC9 超时记 timeout，网络错误记 network', async () => {
  const hang = fakeFeishu({ hang: true })
  assert.deepEqual(await sendFeishuTexts({ fetchFn: hang.fetchFn, appId: 'cli_x', appSecret: SECRET, email: EMAIL, texts: ['a'], totalTimeoutMs: 50 }), [{ status: 'failed', code: 'timeout' }])
  const broken = async () => { throw new TypeError('fetch failed') }
  assert.deepEqual(await sendFeishuTexts({ fetchFn: broken, appId: 'cli_x', appSecret: SECRET, email: EMAIL, texts: ['a', 'b'] }), [{ status: 'failed', code: 'network' }, { status: 'failed', code: 'network' }])
})

test('#48 飞书正文：写明分支、提交、失败项、影响和 Actions 链接', () => {
  assert.equal(toCiRedText(MAIN_RED), [
    'Mivo CI 变红：main', '提交：aaaaaaaa', '失败：CI=failure', '影响：合并通道已暂停，main 转全绿后约 1 分钟自动恢复',
    `查看：https://github.com/${MIVO}/actions?query=branch%3Amain`,
  ].join('\n'))
  assert.equal(toCiRedText(INT_RED), [
    'Mivo CI 变红：integration/x', '提交：99999999', '失败：Windows plugin smoke=failure', '影响：合进这个分支的 PR 先不合（在用的 PR：#1、#2）',
    `查看：https://github.com/${MIVO}/actions?query=branch%3Aintegration%2Fx`,
  ].join('\n'))
})

// SC10

test('#48 SC10 app.json 的 feishu 段可以不写；写了四项都要非空字符串，否则报错写明字段名', () => {
  const base = { app_id: 1, key_path: '/k', installations: { o: 1 } }
  assert.equal(toAppConfig(base).feishu, null)
  const full = { app_id: 'cli_x', keychain_service: 's', keychain_account: 'a', to_email: EMAIL }
  assert.deepEqual(toAppConfig({ ...base, feishu: full }).feishu, { appId: 'cli_x', keychainService: 's', keychainAccount: 'a', toEmail: EMAIL })
  for (const key of Object.keys(full)) {
    assert.throws(() => toFeishuConfig({ ...full, [key]: ' ' }), new RegExp(`app\\.json\\.feishu\\.${key} 应为非空字符串`))
  }
  assert.throws(() => toFeishuConfig('x'), /app\.json\.feishu 应为对象/)
})

// SC6：脚本入口（扮演 Cindy 宿主，飞书用本机假服务器）

async function withFeishuServer(fn) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      calls.push({ path: req.url.split('?')[0], body: JSON.parse(body || '{}') })
      const path = req.url.split('?')[0]
      const data = path.endsWith('/tenant_access_token/internal') ? { code: 0, tenant_access_token: 'tok' }
        : path.endsWith('/batch_get_id') ? { code: 0, data: { user_list: [{ user_id: 'ou_x' }] } } : { code: 0 }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn({ api: `http://127.0.0.1:${server.address().port}`, calls })
  } finally {
    server.close()
  }
}

function writeConfig({ feishu }) {
  const dir = makeTempDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ app_id: 1, key_path: '/k', installations: { xindong: 2 }, shadow: false, ...(feishu ? { feishu } : {}) }))
  return dir
}

async function runAsHost({ events, extraEnv }) {
  const child = spawn(process.execPath, [join(root, 'scripts', 'cindy-tick.mjs')], {
    env: {
      ...process.env, CINDY_SCRIPT_PROTOCOL: '1', PRAISE_MERGE_STATE: makeTempDir(), PRAISE_MERGE_PARTNER_SESSION: 'dev::partner',
      PRAISE_MERGE_TICK_CMD: JSON.stringify([process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify({ shadow: false, events }))})`]),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames = []
  child.stdin.write(`${JSON.stringify({ protocol: 'cindy-script/1', type: 'start', context: {} })}\n`)
  for await (const line of createInterface({ input: child.stdout })) {
    const frame = JSON.parse(line)
    frames.push(frame)
    if (frame.type === 'call') child.stdin.write(`${JSON.stringify({ protocol: 'cindy-script/1', type: 'call_result', id: frame.id, ok: true, result: { target_session_id: frame.params.target_session_id } })}\n`)
    if (frame.type === 'complete') child.stdin.end()
  }
  await new Promise((resolve) => child.on('close', resolve))
  const call = frames.find((f) => f.type === 'call')
  return { message: call?.params.message ?? null, summary: JSON.parse(frames.find((f) => f.type === 'complete').resultText) }
}

const FEISHU = { app_id: 'cli_x', keychain_service: 's', keychain_account: 'a', to_email: EMAIL }
const secretCmd = (value) => JSON.stringify([process.execPath, '-e', value === null ? 'process.exit(44)' : `process.stdout.write(${JSON.stringify(value)})`])

test('#48 SC6 有红灯：每条红灯用 Mivo 机器人发一条私聊，结果写进本轮结果和给伙伴的消息，不含邮箱和密钥', async () => {
  await withFeishuServer(async ({ api, calls }) => {
    const { message, summary } = await runAsHost({
      events: [MAIN_RED, INT_RED, { type: 'merged', repo: MIVO, pr: 3, head: 'h' }],
      extraEnv: { PRAISE_MERGE_CONFIG: writeConfig({ feishu: FEISHU }), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: secretCmd(SECRET) },
    })
    const sends = calls.filter((c) => c.path === '/im/v1/messages')
    assert.equal(sends.length, 2)
    assert.match(JSON.parse(sends[0].body.content).text, /^Mivo CI 变红：main\n提交：aaaaaaaa/)
    assert.match(JSON.parse(sends[1].body.content).text, /^Mivo CI 变红：integration\/x\n/)
    assert.deepEqual(summary.feishu, [{ branch: 'main', status: 'sent' }, { branch: 'integration/x', status: 'sent' }])
    assert.match(message, /飞书（Mivo 机器人）已发给用户：main CI 变红。/)
    assert.match(message, /飞书（Mivo 机器人）已发给用户：integration\/x CI 变红。/)
    for (const text of [message, JSON.stringify(summary)]) assert.ok(!text.includes(EMAIL) && !text.includes(SECRET))
  })
})

test('#48 SC6 app.json 没配 feishu：不发，写明 not-configured；读不到密钥：写明 no-credential，不发请求', async () => {
  await withFeishuServer(async ({ api, calls }) => {
    const none = await runAsHost({ events: [MAIN_RED], extraEnv: { PRAISE_MERGE_CONFIG: writeConfig({}), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: secretCmd(SECRET) } })
    assert.deepEqual(none.summary.feishu, [{ branch: 'main', status: 'failed', code: 'not-configured' }])
    assert.match(none.message, /没发出去：main CI 变红，原因码 not-configured。/)
    const noSecret = await runAsHost({ events: [MAIN_RED], extraEnv: { PRAISE_MERGE_CONFIG: writeConfig({ feishu: FEISHU }), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: secretCmd(null) } })
    assert.deepEqual(noSecret.summary.feishu, [{ branch: 'main', status: 'failed', code: 'no-credential' }])
    assert.equal(calls.length, 0, '两种情况都不发飞书请求')
  })
})

test('#48 SC6 这一轮没有红灯：不读配置、不读钥匙串、不发飞书请求，给伙伴的消息不变', async () => {
  await withFeishuServer(async ({ api, calls }) => {
    const marker = join(makeTempDir(), 'secret-read')
    const { message, summary } = await runAsHost({
      events: [{ type: 'merged', repo: MIVO, pr: 3, head: 'h' }],
      extraEnv: { PRAISE_MERGE_CONFIG: join(makeTempDir(), 'missing'), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: JSON.stringify([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`]) },
    })
    assert.equal(summary.feishu, undefined)
    assert.equal(calls.length, 0)
    assert.ok(!message.includes('飞书'))
    assert.equal(existsSync(marker), false, '没读钥匙串')
  })
})
