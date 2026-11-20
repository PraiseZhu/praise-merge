// #53：CI 红灯的飞书通知发给谁。main 发给弄红它的 PR 作者；集成分支发给负责人和弄红它的 PR 作者；
// 没通知到（机器人、名册没有、名册读不到、飞书查不到、发送失败、没有通知对象）才转给兜底收件人（用户），第一行写明原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isBotLogin, selectRosterEmail, toDistinctLogins, toRosterRow } from '../src/roster.mjs'
import { sendRedNotices, toFeishuNote, toForwardNote, toRedNoticePlan, toRedTargets } from '../src/red-notice.mjs'
import { toCauseLine, toCiRedText } from '../src/feishu.mjs'

const MIVO = 'xindong/mivo-canvas-plugin'
const INT = 'integration/generation-recovery'
const HEAD = 'b8c674ab'.padEnd(40, '0')
const FIRST_RED = '01930d3e'.padEnd(40, '0')
const USER_EMAIL = 'user@example.invalid'
// 名册正文：和 xindong/org 的 README 一样是几张表，一行一个人
const ROSTER = [
  '# 名册',
  '| GitHub | Name | Email | Role |',
  '|---|---|---|---|',
  '| [@aj0928](https://github.com/aj0928) | 甲 | aj@example.invalid | member |',
  '| [@Alice](https://github.com/Alice) | 乙 | alice@example.invalid | maintainer |',
  '| [@PraiseZhu](https://github.com/PraiseZhu) | 丙 | user@example.invalid | maintainer |',
  '| [@no-mail](https://github.com/no-mail) | 丁 |  | member |',
  '',
  '| GitHub | Name | Email | Role |',
  '|---|---|---|---|',
  '| [@aj0928](https://github.com/aj0928) | 甲 | aj-second@example.invalid | member |',
].join('\n')
const ROSTERS = { rosterTexts: [ROSTER] }

const mainRed = (cause) => ({ type: 'main_ci_red', repo: MIVO, pr: null, branch: 'main', head: HEAD, reason: 'main b8c674ab CI=failure', cause })
const intRed = (cause, owners) => ({ type: 'integration_ci_red', repo: MIVO, pr: null, branch: INT, head: HEAD, reason: `${INT} b8c674ab CI=failure（在用的 PR：#2613）`, cause, owners })
const cause = (author, extra = {}) => ({ sha: HEAD, pr: 2612, author, certain: true, ...extra })

// 假发送器：记下每次发给哪个邮箱、正文；answers 按邮箱指定失败的原因码
function fakeSender(answers = {}) {
  const sends = []
  return {
    sends,
    send: async (email, text) => {
      sends.push({ email, text })
      return answers[email] ? { status: 'failed', code: answers[email] } : { status: 'sent' }
    },
  }
}

async function notify(events, { sender = fakeSender(), rosters = ROSTERS } = {}) {
  const plans = events.map((ev) => toRedNoticePlan(ev, rosters))
  const results = await sendRedNotices({ red: events, plans, sender, fallbackEmail: USER_EMAIL })
  return { results, sends: sender.sends }
}

// 名册

test('#53 名册：按 GitHub 账号取邮箱，不分大小写，取先出现的一行；没有邮箱或不在名册返回 null', () => {
  assert.equal(selectRosterEmail([ROSTER], 'AJ0928'), 'aj@example.invalid')
  assert.equal(selectRosterEmail([ROSTER], 'alice'), 'alice@example.invalid')
  assert.equal(selectRosterEmail([ROSTER], 'no-mail'), null)
  assert.equal(selectRosterEmail([ROSTER], 'stranger'), null)
  assert.equal(selectRosterEmail([ROSTER], ''), null)
  assert.equal(selectRosterEmail(['别的名册', ROSTER], 'alice'), 'alice@example.invalid', '多份名册逐份找')
  assert.deepEqual(toRosterRow('| [@x](https://github.com/x) | 名 | x@example.invalid | member |'), { login: 'x', email: 'x@example.invalid' })
  assert.equal(toRosterRow('| GitHub | Name | Email | Role |'), null)
})

test('#53 机器人账号：<name>[bot]、app/<name>、空账号都算；账号去重不分大小写', () => {
  for (const login of ['praise-qa[bot]', 'app/praise-qa', '', null, undefined]) assert.equal(isBotLogin(login), true, String(login))
  assert.equal(isBotLogin('aj0928'), false)
  assert.deepEqual(toDistinctLogins(['Alice', null, 'alice', 'bob', '']), ['Alice', 'bob'])
})

// SC1

test('#53 SC1 main 红、弄红它的 PR 作者在名册里：只发给作者，不发给兜底收件人', async () => {
  const { results, sends } = await notify([mainRed(cause('alice'))])
  assert.deepEqual(sends.map((s) => s.email), ['alice@example.invalid'])
  assert.deepEqual(results, [{ branch: 'main', to: 'alice', status: 'sent' }])
  assert.match(sends[0].text, /^Mivo CI 变红：main\n/, '发给本人的正文前面没有转发说明')
  assert.ok(sends[0].text.includes(`弄红它的 PR：#2612（alice） https://github.com/${MIVO}/pull/2612`))
})

// SC3

test('#53 SC3 集成分支红：负责人和弄红它的 PR 作者各发一条；同一个人只发一条', async () => {
  assert.deepEqual(toRedTargets(intRed(cause('alice'), ['aj0928'])), ['aj0928', 'alice'])
  const two = await notify([intRed(cause('alice'), ['aj0928'])])
  assert.deepEqual(two.sends.map((s) => s.email), ['aj@example.invalid', 'alice@example.invalid'])
  assert.deepEqual(two.results, [{ branch: INT, to: 'aj0928', status: 'sent' }, { branch: INT, to: 'alice', status: 'sent' }])
  assert.equal(two.sends[0].text, two.sends[1].text, '两个人收到同一份正文')

  const same = await notify([intRed(cause('AJ0928'), ['aj0928'])])
  assert.deepEqual(same.sends.map((s) => s.email), ['aj@example.invalid'], '负责人就是作者（只是大小写不同）')
  assert.deepEqual(same.results, [{ branch: INT, to: 'aj0928', status: 'sent' }])
})

// SC4

test('#53 SC4 没通知到就转给用户：六种情况各发一条给兜底收件人，第一行写明没通知到谁和原因', async () => {
  const cases = [
    ['作者是机器人', [mainRed(cause('praise-qa[bot]'))], {}, ROSTERS, '没通知到 @praise-qa[bot]（机器人账号），这条先转给你。', [{ login: 'praise-qa[bot]', reason: 'bot' }]],
    ['名册里没有', [mainRed(cause('stranger'))], {}, ROSTERS, '没通知到 @stranger（名册里没有），这条先转给你。', [{ login: 'stranger', reason: 'not-in-roster' }]],
    ['名册读不到', [mainRed(cause('alice'))], {}, { rosterTexts: [] }, '没通知到 @alice（名册读不到），这条先转给你。', [{ login: 'alice', reason: 'roster-unavailable' }]],
    ['飞书查不到', [mainRed(cause('alice'))], { 'alice@example.invalid': 'feishu-user-not-found' }, ROSTERS, '没通知到 @alice（名册里的邮箱飞书查不到），这条先转给你。', [{ login: 'alice', reason: 'feishu-user-not-found' }]],
    ['发送失败', [mainRed(cause('alice'))], { 'alice@example.invalid': 'send-230013' }, ROSTERS, '没通知到 @alice（飞书没发出去，原因码 send-230013），这条先转给你。', [{ login: 'alice', reason: 'send-230013' }]],
  ]
  for (const [name, events, answers, rosters, note, missed] of cases) {
    const { results, sends } = await notify(events, { sender: fakeSender(answers), rosters })
    const toUser = sends.filter((s) => s.email === USER_EMAIL)
    assert.equal(toUser.length, 1, name)
    assert.equal(toUser[0].text.split('\n')[0], note, name)
    assert.equal(toUser[0].text.split('\n')[1], 'Mivo CI 变红：main', `${name}：说明后面是完整正文`)
    assert.deepEqual(results.at(-1), { branch: 'main', to: null, status: 'sent', fallback: true, missed }, name)
  }
  // 第六种：一个通知对象都没有（没查到弄红它的 PR）
  const none = await notify([mainRed(null)])
  assert.deepEqual(none.sends.map((s) => s.email), [USER_EMAIL])
  assert.equal(none.sends[0].text.split('\n')[0], '没找到该通知谁，这条先发给你。')
  assert.ok(none.sends[0].text.includes('弄红它的 PR：没查到'))
  assert.deepEqual(none.results, [{ branch: 'main', to: null, status: 'sent', fallback: true, noTarget: true }])
})

test('#53 SC4 一部分人通知到了：通知到的照发，没通知到的另转给用户一条', async () => {
  const { results, sends } = await notify([intRed(cause('praise-qa[bot]'), ['aj0928', 'stranger'])])
  assert.deepEqual(sends.map((s) => s.email), ['aj@example.invalid', USER_EMAIL])
  assert.equal(sends[1].text.split('\n')[0], '没通知到 @stranger（名册里没有）、@praise-qa[bot]（机器人账号），这条先转给你。')
  assert.deepEqual(results, [
    { branch: INT, to: 'aj0928', status: 'sent' },
    { branch: INT, to: null, status: 'sent', fallback: true, missed: [{ login: 'stranger', reason: 'not-in-roster' }, { login: 'praise-qa[bot]', reason: 'bot' }] },
  ])
})

test('#53 SC4 用户本人就是通知对象：只收一条，不带转发说明；同时替别人转时这一条带说明', async () => {
  const own = await notify([mainRed(cause('PraiseZhu'))])
  assert.deepEqual(own.sends.map((s) => s.email), [USER_EMAIL])
  assert.match(own.sends[0].text, /^Mivo CI 变红：main\n/)
  assert.deepEqual(own.results, [{ branch: 'main', to: 'PraiseZhu', status: 'sent' }])

  const both = await notify([intRed(cause('stranger'), ['PraiseZhu', 'aj0928'])])
  assert.deepEqual(both.sends.map((s) => s.email), ['aj@example.invalid', USER_EMAIL], '用户只收一条，放在最后发')
  assert.equal(both.sends[1].text.split('\n')[0], '没通知到 @stranger（名册里没有），这条先转给你。')
  assert.deepEqual(both.results, [
    { branch: INT, to: 'aj0928', status: 'sent' },
    { branch: INT, to: 'PraiseZhu', status: 'sent', missed: [{ login: 'stranger', reason: 'not-in-roster' }] },
  ])
})

test('#53 SC4 转给用户的那一条也没发出去：结果里写明原因码和没通知到谁', async () => {
  const { results } = await notify([mainRed(cause('stranger'))], { sender: fakeSender({ [USER_EMAIL]: 'send-230001' }) })
  assert.deepEqual(results, [{ branch: 'main', to: null, status: 'failed', code: 'send-230001', fallback: true, missed: [{ login: 'stranger', reason: 'not-in-roster' }] }])
})

test('#53 SC4 两条红灯同一轮：各自按自己的通知对象发', async () => {
  const { sends } = await notify([mainRed(cause('alice')), intRed(cause('aj0928'), ['aj0928'])])
  assert.deepEqual(sends.map((s) => [s.email, s.text.split('\n')[0]]), [
    ['alice@example.invalid', 'Mivo CI 变红：main'],
    ['aj@example.invalid', `Mivo CI 变红：${INT}`],
  ])
})

// SC2 / SC5：正文

test('#53 SC2 正文：找准了写「弄红它的 PR」；红从更早的提交开始时写明从哪个提交起；找不准写「最早确认变红」和「不一定」', () => {
  const at = (c) => toCauseLine({ repo: MIVO, head: HEAD, cause: c })
  assert.equal(at(cause('alice')), `弄红它的 PR：#2612（alice） https://github.com/${MIVO}/pull/2612`)
  assert.equal(at({ sha: FIRST_RED, pr: 2599, author: 'aj0928', certain: true }), `弄红它的 PR：#2599（aj0928，从提交 01930d3e 起一直红） https://github.com/${MIVO}/pull/2599`)
  assert.equal(at(cause('alice', { certain: false })), `最早确认变红的 PR：#2612（alice）（更早的提交没有 CI 结论，不一定是它弄红的） https://github.com/${MIVO}/pull/2612`)
  assert.equal(at(null), '弄红它的 PR：没查到')
  assert.equal(at(undefined), null, '升级前的事件没有 cause，不加这一行')
})

test('#53 SC5 正文：没有对应的 PR 写提交、提交人和「直接推送」；提交人也没有写「提交人未知」', () => {
  const at = (c) => toCauseLine({ repo: MIVO, head: HEAD, cause: c })
  assert.equal(at({ sha: HEAD, pr: null, author: 'dave', certain: true }), '弄红它的提交：b8c674ab（dave 直接推送，没有对应的 PR）')
  assert.equal(at({ sha: HEAD, pr: null, author: null, certain: false }), '最早确认变红的提交：b8c674ab（直接推送，没有对应的 PR，提交人未知）（更早的提交没有 CI 结论，不一定是它弄红的）')
})

test('#53 SC2 飞书正文全文：集成分支带「弄红它的 PR」「分支负责人」，最后一行说明是自动通知；main 不带负责人', () => {
  assert.equal(toCiRedText(intRed({ sha: FIRST_RED, pr: 2599, author: 'aj0928', certain: true }, ['aj0928'])), [
    `Mivo CI 变红：${INT}`,
    '提交：b8c674ab',
    '失败：CI=failure',
    `弄红它的 PR：#2599（aj0928，从提交 01930d3e 起一直红） https://github.com/${MIVO}/pull/2599`,
    '分支负责人：aj0928',
    '影响：合进这个分支的 PR 先不合（在用的 PR：#2613）',
    `查看：https://github.com/${MIVO}/actions?query=branch%3Aintegration%2Fgeneration-recovery`,
    '（合并伙伴自动通知，在这里回复没人收得到）',
  ].join('\n'))
  const main = toCiRedText({ ...mainRed(cause('alice')), owners: ['ignored'] })
  assert.ok(!main.includes('分支负责人'))
  assert.ok(main.includes('影响：合并通道已暂停，main 转全绿后约 1 分钟自动恢复'))
})

// SC6

test('#53 SC6 给伙伴的一行：写明发给了哪个账号、没通知到谁；结果和这一行里都没有邮箱', async () => {
  assert.equal(toFeishuNote({ branch: 'main', to: 'alice', status: 'sent' }), '飞书（Mivo 机器人）已发给 @alice：main CI 变红。')
  assert.equal(toFeishuNote({ branch: INT, to: 'alice', status: 'failed', code: 'send-230013' }), `飞书（Mivo 机器人）没发给 @alice：${INT} CI 变红，原因码 send-230013。`)
  assert.equal(toFeishuNote({ branch: 'main', to: null, status: 'sent', fallback: true, missed: [{ login: 'stranger', reason: 'not-in-roster' }] }),
    '飞书（Mivo 机器人）已发给用户（兜底）：main CI 变红；没通知到 @stranger（名册里没有）。')
  assert.equal(toFeishuNote({ branch: 'main', to: null, status: 'sent', fallback: true, noTarget: true }), '飞书（Mivo 机器人）已发给用户（兜底）：main CI 变红；没找到该通知谁。')
  assert.equal(toFeishuNote({ branch: 'main', to: null, status: 'failed', code: 'not-configured' }), '飞书（Mivo 机器人）没发出去：main CI 变红，原因码 not-configured。')
  assert.equal(toForwardNote({ missed: [], noTarget: false }), null)

  const { results } = await notify([intRed(cause('stranger'), ['aj0928', 'PraiseZhu'])])
  const text = JSON.stringify(results) + results.map(toFeishuNote).join('\n')
  assert.ok(!text.includes('@example.invalid'), '没有邮箱')
})

// SC9

test('#53 SC9 运维手册、总览、README 写明发给谁、名册配置、没通知到的原因；手册里的正文示例就是 toCiRedText 的输出', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const ops = read('docs/operations.md')
  const section = ops.slice(ops.indexOf('### CI 变红飞书通知'), ops.indexOf('### 合入后通知发起合并的会话'))
  for (const phrase of ['发给弄红它的 PR 的作者', '**集成分支负责人**（事件里的 `owners`）', '**弄红它的 PR**（事件里的 `cause`）', '沿第一父提交往回找', '最早确认变红的 PR',
    '`feishu.roster_files`', '兜底收件人 `feishu.to_email`', '不抄送用户', '`not-in-roster`', '`roster-unavailable`', '`feishu-user-not-found`', '`fallback: true`', '`missed`',
    '不走 GitHub 接口读名册', '没通知到 @someone（名册里没有），这条先转给你。', '没找到该通知谁，这条先发给你。']) {
    assert.ok(section.includes(phrase), phrase)
  }
  const sample = section.match(/正文（`src\/feishu\.mjs` 的 `toCiRedText`）：\n\n```\n([^]*?)\n```/)?.[1]
  assert.equal(sample, toCiRedText(intRed({ sha: FIRST_RED, pr: 2599, author: 'aj0928', certain: true }, ['aj0928'])))
  const overview = read('docs/how-it-works.md')
  for (const phrase of ['**发给谁**（2026-11-20 起，#53）', '往回找到最早变红的那个', '不再抄送你']) assert.ok(overview.includes(phrase), phrase)
  const readme = read('README.md')
  for (const phrase of ['`feishu.roster_files`', '`cause`', '`owners`', '兜底收件人 `feishu.to_email`']) assert.ok(readme.includes(phrase), phrase)
})
