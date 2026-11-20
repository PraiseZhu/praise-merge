// #48：CI 变红时巡检脚本用飞书「Mivo」机器人发私聊。发送模块、app.json 的 feishu 段、脚本入口。
// #53：一轮发给好几个人（弄红它的 PR 作者、集成分支负责人、兜底收件人），收件人怎么定见 tests/red-notice.test.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFeishuSender, toCiRedText } from '../src/feishu.mjs'
import { toAppConfig, toFeishuConfig } from '../src/policy.mjs'
import { makeTempDir } from './helpers/fake-github.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const EMAIL = 'someone@example.invalid'
const ALICE = 'alice@example.invalid'
const AJ = 'aj@example.invalid'
const SECRET = 'test-app-secret-value'
const MIVO = 'xindong/mivo-canvas-plugin'
const MAIN_RED = { type: 'main_ci_red', repo: MIVO, pr: null, branch: 'main', reason: 'main aaaaaaaa CI=failure', head: 'a'.repeat(40) }
const INT_RED = { type: 'integration_ci_red', repo: MIVO, pr: null, branch: 'integration/x', reason: 'integration/x 99999999 Windows plugin smoke=failure（在用的 PR：#1、#2）', head: '9'.repeat(40) }
const toOpenId = (email) => `ou_${email.split('@')[0].toLowerCase()}`
// 飞书按邮箱查人的应答：每个邮箱一项，带回查询的邮箱；notFound 里的邮箱没有 user_id
const toLookup = (emails, notFound = []) => ({ code: 0, data: { user_list: emails.map((email) => (notFound.includes(email) ? { email } : { email, user_id: toOpenId(email) })) } })

// 假飞书：按路径回答，记下每个请求；answers 可覆盖某一步的返回
function fakeFeishu(answers = {}) {
  const calls = []
  const reply = { token: { code: 0, tenant_access_token: 'tok' }, send: { code: 0 }, ...answers }
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body)
    calls.push({ path, body, auth: init.headers.Authorization ?? null })
    // 挂起：等到被取消。AbortSignal.timeout 的定时器不占事件循环（真实 fetch 有连接占着），这里另挂一个定时器占住，取消时清掉
    if (reply.hang) {
      return new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 60_000)
        init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason) })
      })
    }
    const data = path.endsWith('/tenant_access_token/internal') ? reply.token
      : path.endsWith('/batch_get_id') ? reply.lookup ?? toLookup(body.emails, reply.notFound)
        : reply.send
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchFn, calls }
}

const open = (fetchFn, extra = {}) => openFeishuSender({ fetchFn, apiBase: 'https://feishu.test', appId: 'cli_x', appSecret: SECRET, emails: [EMAIL], ...extra })

// #48 SC9 / #53 SC8

test('#53 SC8 取 token → 一次查完全部邮箱的 open_id → 每条消息各发一条；token 和查询只做一次，邮箱不分大小写去重', async () => {
  const { fetchFn, calls } = fakeFeishu()
  const sender = await open(fetchFn, { emails: [ALICE, AJ, ALICE, 'AJ@example.invalid'] })
  assert.equal(sender.error, null)
  assert.deepEqual(await sender.send(ALICE, '一'), { status: 'sent' })
  assert.deepEqual(await sender.send(AJ, '二'), { status: 'sent' })
  assert.deepEqual(calls.map((c) => c.path), ['/auth/v3/tenant_access_token/internal', '/contact/v3/users/batch_get_id', '/im/v1/messages', '/im/v1/messages'])
  assert.deepEqual(calls[0].body, { app_id: 'cli_x', app_secret: SECRET })
  assert.equal(calls[1].body.emails.length, 2, '两个邮箱只查一次')
  assert.equal(calls[1].auth, 'Bearer tok')
  assert.deepEqual(calls[2].body, { receive_id: 'ou_alice', msg_type: 'text', content: JSON.stringify({ text: '一' }) })
  assert.equal(calls[3].body.receive_id, 'ou_aj')
})

test('#53 SC8 邮箱超过 50 个：分批查，每批最多 50 个', async () => {
  const { fetchFn, calls } = fakeFeishu()
  const emails = Array.from({ length: 51 }, (_, i) => `u${i}@example.invalid`)
  const sender = await open(fetchFn, { emails })
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/batch_get_id')).map((c) => c.body.emails.length), [50, 1])
  assert.deepEqual(await sender.send(emails[50], 'x'), { status: 'sent' })
})

test('#53 SC8 准备阶段失败给固定原因码：读不到密钥、取 token 失败、查询失败；结果里没有邮箱和密钥', async () => {
  const cases = [
    ['读不到密钥', {}, null, 'no-credential', 0],
    ['取 token 失败', { token: { code: 10003 } }, SECRET, 'token-10003', 1],
    ['查询失败', { lookup: { code: 99991672 } }, SECRET, 'lookup-99991672', 2],
  ]
  for (const [name, answers, appSecret, code, requests] of cases) {
    const { fetchFn, calls } = fakeFeishu(answers)
    const sender = await open(fetchFn, { appSecret })
    assert.deepEqual(sender, { error: code }, name)
    assert.equal(calls.length, requests, `${name}：请求数`)
    assert.ok(!JSON.stringify(sender).includes(EMAIL) && !JSON.stringify(sender).includes(SECRET), name)
  }
})

test('#53 SC8 发送阶段各自记结果：这个邮箱查不到人记 feishu-user-not-found（不发请求），飞书拒收记 send-<code>', async () => {
  const missing = fakeFeishu({ notFound: [ALICE] })
  const sender = await open(missing.fetchFn, { emails: [ALICE, EMAIL] })
  assert.deepEqual(await sender.send(ALICE, '正文'), { status: 'failed', code: 'feishu-user-not-found' })
  assert.deepEqual(await sender.send('never-asked@example.invalid', '正文'), { status: 'failed', code: 'feishu-user-not-found' }, '没查过的邮箱同样记查不到')
  assert.equal(missing.calls.length, 2, '查不到人不发消息请求')
  assert.deepEqual(await sender.send(EMAIL, '正文'), { status: 'sent' }, '别人照发')

  const refused = fakeFeishu({ send: { code: 230001 } })
  assert.deepEqual(await (await open(refused.fetchFn)).send(EMAIL, '正文'), { status: 'failed', code: 'send-230001' })
  assert.equal(refused.calls.length, 3)
})

test('#48 SC9 超时记 timeout，网络错误记 network', async () => {
  const hang = fakeFeishu({ hang: true })
  assert.deepEqual(await open(hang.fetchFn, { totalTimeoutMs: 50 }), { error: 'timeout' })
  const broken = async () => { throw new TypeError('fetch failed') }
  assert.deepEqual(await open(broken), { error: 'network' })
})

test('#48 SC9 同一批里后一条发送断线：前一条仍记已发出，后一条记 network，再后一条照样尝试', async () => {
  let sends = 0
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname
    const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    if (path.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 'tok' })
    if (path.endsWith('/batch_get_id')) return json(toLookup(JSON.parse(init.body).emails))
    sends += 1
    if (sends === 2) throw new TypeError('fetch failed')
    return json({ code: 0 })
  }
  const sender = await open(fetchFn)
  const results = []
  for (const text of ['一', '二', '三']) results.push(await sender.send(EMAIL, text))
  assert.deepEqual(results, [{ status: 'sent' }, { status: 'failed', code: 'network' }, { status: 'sent' }])
})

test('#48 SC9 响应头已到、读响应体时超时：记 timeout，不是 send-200；响应体不是 JSON 才带 HTTP 状态', async () => {
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  const stalledBody = (signal) => new Response(new ReadableStream({
    start(controller) {
      const keepAlive = setTimeout(() => {}, 60_000)
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); controller.error(signal.reason) })
    },
  }), { status: 200 })
  const make = (send) => async (url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 'tok' })
    if (path.endsWith('/batch_get_id')) return json(toLookup(JSON.parse(init.body).emails))
    return send(init)
  }
  assert.deepEqual(await (await open(make((init) => stalledBody(init.signal)), { totalTimeoutMs: 50 })).send(EMAIL, 'a'), { status: 'failed', code: 'timeout' })
  assert.deepEqual(await (await open(make(() => new Response('<html>', { status: 502 })))).send(EMAIL, 'a'), { status: 'failed', code: 'send-502' })
})

test('#48 飞书正文：写明分支、提交、失败项、影响和 Actions 链接；事件里没有 cause 时不加「弄红它的 PR」一行', () => {
  assert.equal(toCiRedText(MAIN_RED), [
    'Mivo CI 变红：main', '提交：aaaaaaaa', '失败：CI=failure', '影响：合并通道已暂停，main 转全绿后约 1 分钟自动恢复',
    `查看：https://github.com/${MIVO}/actions?query=branch%3Amain`, '（合并伙伴自动通知，在这里回复没人收得到）',
  ].join('\n'))
  assert.equal(toCiRedText(INT_RED), [
    'Mivo CI 变红：integration/x', '提交：99999999', '失败：Windows plugin smoke=failure', '影响：合进这个分支的 PR 先不合（在用的 PR：#1、#2）',
    `查看：https://github.com/${MIVO}/actions?query=branch%3Aintegration%2Fx`, '（合并伙伴自动通知，在这里回复没人收得到）',
  ].join('\n'))
})

// #48 SC10 / #53 SC7

test('#48 SC10 app.json 的 feishu 段可以不写；写了四项都要非空字符串，否则报错写明字段名', () => {
  const base = { app_id: 1, key_path: '/k', installations: { o: 1 } }
  assert.equal(toAppConfig(base).feishu, null)
  const full = { app_id: 'cli_x', keychain_service: 's', keychain_account: 'a', to_email: EMAIL }
  assert.deepEqual(toAppConfig({ ...base, feishu: full }).feishu, { appId: 'cli_x', keychainService: 's', keychainAccount: 'a', toEmail: EMAIL, rosterFiles: [] })
  for (const key of Object.keys(full)) {
    assert.throws(() => toFeishuConfig({ ...full, [key]: ' ' }), new RegExp(`app\\.json\\.feishu\\.${key} 应为非空字符串`))
  }
  assert.throws(() => toFeishuConfig('x'), /app\.json\.feishu 应为对象/)
})

test('#53 SC7 feishu.roster_files 可以不写（空数组）；写了必须是绝对路径的字符串数组，否则报错写明字段名', () => {
  const full = { app_id: 'cli_x', keychain_service: 's', keychain_account: 'a', to_email: EMAIL }
  assert.deepEqual(toFeishuConfig(full).rosterFiles, [])
  assert.deepEqual(toFeishuConfig({ ...full, roster_files: ['/a/README.md', '/b/README.md'] }).rosterFiles, ['/a/README.md', '/b/README.md'])
  for (const bad of [null, '/a/README.md', ['relative/README.md'], ['~/README.md'], [42], [null]]) {
    assert.throws(() => toFeishuConfig({ ...full, roster_files: bad }), /app\.json\.feishu\.roster_files 应为绝对路径的字符串数组/, JSON.stringify(bad))
  }
})

// 脚本入口（扮演 Cindy 宿主，飞书用本机假服务器）

async function withFeishuServer(fn) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      const path = req.url.split('?')[0]
      const parsed = JSON.parse(body || '{}')
      calls.push({ path, body: parsed })
      const data = path.endsWith('/tenant_access_token/internal') ? { code: 0, tenant_access_token: 'tok' }
        : path.endsWith('/batch_get_id') ? toLookup(parsed.emails) : { code: 0 }
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

// 名册文件：和 xindong/org 的 README 一样的表格
function writeRoster() {
  const dir = makeTempDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'README.md')
  writeFileSync(file, [
    '| GitHub | Name | Email | Role |', '|---|---|---|---|',
    `| [@alice](https://github.com/alice) | 甲 | ${ALICE} | member |`,
    `| [@aj0928](https://github.com/aj0928) | 乙 | ${AJ} | member |`,
  ].join('\n'))
  return file
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
const sendsOf = (calls) => calls.filter((c) => c.path === '/im/v1/messages').map((c) => ({ to: c.body.receive_id, text: JSON.parse(c.body.content).text }))

test('#53 SC1 脚本入口：main 红发给弄红它的 PR 作者，集成分支红发给负责人，都不发给兜底收件人；结果写明发给了谁，不含邮箱和密钥', async () => {
  await withFeishuServer(async ({ api, calls }) => {
    const { message, summary } = await runAsHost({
      events: [
        { ...MAIN_RED, cause: { sha: MAIN_RED.head, pr: 77, author: 'alice', certain: true } },
        { ...INT_RED, cause: { sha: INT_RED.head, pr: 78, author: 'aj0928', certain: true }, owners: ['aj0928'] },
        { type: 'merged', repo: MIVO, pr: 3, head: 'h' },
      ],
      extraEnv: { PRAISE_MERGE_CONFIG: writeConfig({ feishu: { ...FEISHU, roster_files: [writeRoster()] } }), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: secretCmd(SECRET) },
    })
    const sends = sendsOf(calls)
    assert.deepEqual(sends.map((s) => s.to), ['ou_alice', 'ou_aj'], '不发给兜底收件人 ou_someone')
    assert.match(sends[0].text, /^Mivo CI 变红：main\n提交：aaaaaaaa\n失败：CI=failure\n弄红它的 PR：#77（alice） https:\/\/github\.com\/xindong\/mivo-canvas-plugin\/pull\/77\n/)
    assert.match(sends[1].text, /^Mivo CI 变红：integration\/x\n[^]*\n分支负责人：aj0928\n/)
    assert.equal(calls.filter((c) => c.path.endsWith('/batch_get_id')).length, 1, '收件人一次查完')
    assert.deepEqual(summary.feishu, [{ branch: 'main', to: 'alice', status: 'sent' }, { branch: 'integration/x', to: 'aj0928', status: 'sent' }])
    assert.match(message, /飞书（Mivo 机器人）已发给 @alice：main CI 变红。/)
    assert.match(message, /飞书（Mivo 机器人）已发给 @aj0928：integration\/x CI 变红。/)
    for (const text of [message, JSON.stringify(summary)]) assert.ok(![EMAIL, ALICE, AJ, SECRET].some((secret) => text.includes(secret)))
  })
})

test('#53 SC4 脚本入口：没配名册、名册文件读不到、事件里没有 cause：都转给兜底收件人，第一行写明原因', async () => {
  const withCause = { ...MAIN_RED, cause: { sha: MAIN_RED.head, pr: 77, author: 'alice', certain: true } }
  const cases = [
    ['没配 roster_files', FEISHU, withCause, '没通知到 @alice（名册读不到），这条先转给你。', { missed: [{ login: 'alice', reason: 'roster-unavailable' }] }],
    ['名册文件读不到', { ...FEISHU, roster_files: [join(makeTempDir(), 'missing', 'README.md')] }, withCause, '没通知到 @alice（名册读不到），这条先转给你。', { missed: [{ login: 'alice', reason: 'roster-unavailable' }] }],
    ['没有 cause', { ...FEISHU, roster_files: [writeRoster()] }, { ...MAIN_RED, cause: null }, '没查到是谁弄红的，这条先转给你。', { culpritUnknown: true }],
  ]
  for (const [name, feishu, event, note, extra] of cases) {
    await withFeishuServer(async ({ api, calls }) => {
      const { message, summary } = await runAsHost({
        events: [event],
        extraEnv: { PRAISE_MERGE_CONFIG: writeConfig({ feishu }), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: secretCmd(SECRET) },
      })
      const sends = sendsOf(calls)
      assert.deepEqual(sends.map((s) => s.to), ['ou_someone'], name)
      assert.equal(sends[0].text.split('\n')[0], note, name)
      assert.deepEqual(summary.feishu, [{ branch: 'main', to: null, status: 'sent', fallback: true, ...extra }], name)
      assert.match(message, /飞书（Mivo 机器人）已发给用户（兜底）：main CI 变红；没/, name)
    })
  }
})

test('#48 SC6 app.json 没配 feishu：不发，写明 not-configured；读不到密钥：写明 no-credential，不发请求', async () => {
  await withFeishuServer(async ({ api, calls }) => {
    // 整轮没发出去时写明本该通知哪些账号（#53 SC6）；事件里没有 cause 时是空的
    const withCause = { ...MAIN_RED, cause: { sha: MAIN_RED.head, pr: 77, author: 'alice', certain: true } }
    const none = await runAsHost({ events: [withCause], extraEnv: { PRAISE_MERGE_CONFIG: writeConfig({}), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: secretCmd(SECRET) } })
    assert.deepEqual(none.summary.feishu, [{ branch: 'main', to: null, status: 'failed', code: 'not-configured', targets: ['alice'] }])
    assert.match(none.message, /没发出去：main CI 变红，原因码 not-configured；本该通知 @alice。/)
    const noSecret = await runAsHost({ events: [MAIN_RED], extraEnv: { PRAISE_MERGE_CONFIG: writeConfig({ feishu: FEISHU }), PRAISE_MERGE_FEISHU_API: api, PRAISE_MERGE_FEISHU_SECRET_CMD: secretCmd(null) } })
    assert.deepEqual(noSecret.summary.feishu, [{ branch: 'main', to: null, status: 'failed', code: 'no-credential', targets: [] }])
    assert.match(noSecret.message, /没发出去：main CI 变红，原因码 no-credential。/)
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
