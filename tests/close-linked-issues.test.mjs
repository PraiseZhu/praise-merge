// 合入后补关 PR 声明要关闭的 issue（Mivo 仓不会按「Closes」自动关，#1949 → #1464）。
// #55：改用合并伙伴的 App 身份，不再调用 gh、不用个人登录
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeLinkedIssues, main, UsageError } from '../scripts/close-linked-issues.mjs'
import { GitHubError } from '../src/github.mjs'
import { makePrivateKey, makeTempDir } from './helpers/fake-github.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const R = 'xindong/mivo-canvas-plugin'
const node = (repo, number, state) => ({ number, state, repository: { nameWithOwner: repo } })

// 假的 App 客户端：按 owner 记下是哪个安装发的请求；failOn 指定某个 issue 号的写请求失败；noInstall 里的 owner 没装 App
function fakeApp({ merged = true, issues = [], failOn = null, noInstall = [] } = {}) {
  const calls = []
  const clientFor = (repo) => {
    const owner = repo.split('/')[0]
    if (noInstall.includes(owner)) throw new Error(`app.json 里没有 ${owner.toLowerCase()} 的安装 ID`)
    return {
      graphql: async (query, variables) => {
        calls.push({ owner, kind: 'graphql', variables })
        return { repository: { pullRequest: { merged, closingIssuesReferences: { nodes: issues } } } }
      },
      request: async (method, path, body) => {
        calls.push({ owner, kind: 'rest', method, path, body })
        if (failOn !== null && path.includes(`/issues/${failOn}`)) throw new GitHubError(method, path, 403, 'Resource not accessible by integration')
        return {}
      },
    }
  }
  return { clientFor, calls }
}

// SC1

test('#55 SC1 PR 已合并：对还开着的关联 issue（含跨仓）先留言再以 completed 关闭，已关的只记下；用的是各仓 owner 的安装', async () => {
  const { clientFor, calls } = fakeApp({ issues: [node(R, 1464, 'OPEN'), node(R, 1463, 'CLOSED'), node('PraiseZhu/other', 7, 'OPEN')] })
  const out = await closeLinkedIssues({ repo: R, pr: 1949, clientFor })
  assert.deepEqual(out, { repo: R, pr: 1949, closed: [`${R}#1464`, 'PraiseZhu/other#7'], already_closed: [`${R}#1463`], failed: [] })
  assert.deepEqual(calls[0], { owner: 'xindong', kind: 'graphql', variables: { owner: 'xindong', name: 'mivo-canvas-plugin', number: 1949 } })
  const writes = calls.filter((c) => c.kind === 'rest').map((c) => [c.owner, c.method, c.path, c.body])
  const comment = `${R}#1949 已合并。PR 正文写了关闭这个 issue，但 GitHub 没有自动关闭，由合并伙伴补关。`
  assert.deepEqual(writes, [
    ['xindong', 'POST', `/repos/${R}/issues/1464/comments`, { body: comment }],
    ['xindong', 'PATCH', `/repos/${R}/issues/1464`, { state: 'closed', state_reason: 'completed' }],
    ['PraiseZhu', 'POST', '/repos/PraiseZhu/other/issues/7/comments', { body: comment }],
    ['PraiseZhu', 'PATCH', '/repos/PraiseZhu/other/issues/7', { state: 'closed', state_reason: 'completed' }],
  ])
})

// SC3

test('#55 SC3 PR 没合并：拒绝，不关任何 issue；查不到 PR 也拒绝', async () => {
  const { clientFor, calls } = fakeApp({ merged: false, issues: [node('o/r', 1, 'OPEN')] })
  await assert.rejects(closeLinkedIssues({ repo: 'o/r', pr: 2, clientFor }), (e) => e instanceof UsageError && /还没合并/.test(e.message))
  assert.equal(calls.filter((c) => c.kind === 'rest').length, 0)
  const missing = { graphql: async () => ({ repository: { pullRequest: null } }) }
  await assert.rejects(closeLinkedIssues({ repo: 'o/r', pr: 2, clientFor: () => missing }), (e) => e instanceof UsageError && /查不到/.test(e.message))
})

test('#55 SC3 一个 issue 留言或关闭失败（403、owner 没装 App）：记进 failed（带错误末行），其余照常关', async () => {
  const { clientFor } = fakeApp({ issues: [node('o/r', 1, 'OPEN'), node('o/r', 2, 'OPEN'), node('stranger/x', 3, 'OPEN')], failOn: 1, noInstall: ['stranger'] })
  const out = await closeLinkedIssues({ repo: 'o/r', pr: 3, clientFor })
  assert.deepEqual(out.closed, ['o/r#2'])
  assert.deepEqual(out.failed, [
    { ref: 'o/r#1', error: 'POST /repos/o/r/issues/1/comments -> 403 Resource not accessible by integration' },
    { ref: 'stranger/x#3', error: 'app.json 里没有 stranger 的安装 ID' },
  ])
})

test('#55 SC3 参数错：仓名和 PR 号不合格就拒绝，不发请求', async () => {
  const { clientFor, calls } = fakeApp()
  await assert.rejects(closeLinkedIssues({ repo: 'bad', pr: 1, clientFor }), UsageError)
  await assert.rejects(closeLinkedIssues({ repo: 'o/r', pr: 0, clientFor }), UsageError)
  assert.equal(calls.length, 0)
})

// SC2：脚本入口，用配置里的 App 私钥换安装令牌，本机假 GitHub

function writeAppConfig() {
  const dir = makeTempDir()
  const keyPath = join(dir, 'app.pem')
  writeFileSync(keyPath, makePrivateKey())
  chmodSync(keyPath, 0o600)
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ app_id: 5642127, key_path: keyPath, installations: { xindong: 179246286 }, shadow: false }))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ repos: { [R]: { lane: 'mivo', required_checks: ['verify'] } } }))
  return dir
}

function fakeGitHub() {
  const calls = []
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url)
    calls.push({ method: init.method ?? 'GET', path: pathname, auth: init.headers?.Authorization ?? null })
    if (pathname === '/app/installations/179246286/access_tokens') return json(201, { token: 'app-installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() })
    if (pathname === '/graphql') return json(200, { data: { repository: { pullRequest: { merged: true, closingIssuesReferences: { nodes: [node(R, 1464, 'OPEN')] } } } } })
    if (pathname === `/repos/${R}/issues/1464/comments`) return json(201, { id: 1 })
    if (pathname === `/repos/${R}/issues/1464`) return json(200, { state: 'closed' })
    return json(404, { message: `fake: 未实现 ${pathname}` })
  }
  return { fetchImpl, calls }
}

test('#55 SC2 脚本入口：用 App 私钥签的 JWT 换安装令牌，查询、留言、关闭都带这个令牌；输出一行 JSON、退出码 0', async () => {
  const { fetchImpl, calls } = fakeGitHub()
  let out = ''
  const code = await main([R, '1949', '--config', writeAppConfig()], { env: {}, fetchImpl, stdout: { write: (s) => { out += s } } })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out), { repo: R, pr: 1949, closed: [`${R}#1464`], already_closed: [], failed: [] })
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /app/installations/179246286/access_tokens', 'POST /graphql', `POST /repos/${R}/issues/1464/comments`, `PATCH /repos/${R}/issues/1464`,
  ])
  assert.match(calls[0].auth, /^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/, '换令牌用的是 App 的 JWT')
  for (const c of calls.slice(1)) assert.equal(c.auth, 'Bearer app-installation-token')
})

test('#55 SC2 配置目录：没给 --config 时用 PRAISE_MERGE_CONFIG；有关闭失败时退出码 1', async () => {
  const { fetchImpl } = fakeGitHub()
  const failing = async (url, init) => (new URL(url).pathname.endsWith('/comments') ? new Response('{"message":"Forbidden"}', { status: 403 }) : fetchImpl(url, init))
  let out = ''
  const code = await main([R, '1949'], { env: { PRAISE_MERGE_CONFIG: writeAppConfig() }, fetchImpl: failing, stdout: { write: (s) => { out += s } } })
  assert.equal(code, 1)
  assert.deepEqual(JSON.parse(out).failed, [{ ref: `${R}#1464`, error: `POST /repos/${R}/issues/1464/comments -> 403 Forbidden` }])
})

test('#55 SC2 脚本源码不调用 gh、不读个人登录', () => {
  const source = readFileSync(join(root, 'scripts/close-linked-issues.mjs'), 'utf8')
  assert.doesNotMatch(source, /child_process|runGh|execFile|spawn/)
})

// SC5

test('#55 SC5 运维手册和 README 写明补关在运行目录跑、用 App 身份；命令里的脚本路径存在', () => {
  const ops = readFileSync(join(root, 'docs/operations.md'), 'utf8')
  const section = ops.slice(ops.indexOf('### 合入后通知发起合并的会话'))
  assert.match(section, /node scripts\/close-linked-issues\.mjs <owner\/repo> <号>/)
  for (const phrase of ['在运行目录 `~/praise-merge-runtime` 下跑', '用合并伙伴的 App 身份，不用个人 `gh` 登录', '`praise-merge[bot]`']) assert.ok(section.includes(phrase), phrase)
  assert.ok(ops.includes('令牌权限与期望的 10 项完全一致'))
  assert.ok(ops.includes('两份安装（PraiseZhu 个人、xindong 组织）都要点同意'))
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  assert.ok(readme.includes('`attest` 是仅有的调用 `gh` 的地方'))
  assert.ok(readme.includes('2026-11-21 起改用 App 令牌（#55）'))
  readFileSync(join(root, 'scripts/close-linked-issues.mjs'))
})
