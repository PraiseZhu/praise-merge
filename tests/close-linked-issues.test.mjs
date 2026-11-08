// 合入后补关 PR 声明要关闭的 issue（Mivo 仓不会按「Closes」自动关，#1949 → #1464）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeLinkedIssues, UsageError } from '../scripts/close-linked-issues.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = (repo, number, state) => ({ number, state, repository: { nameWithOwner: repo } })

function fakeGh({ merged = true, issues = [], failOn = null } = {}) {
  const calls = []
  const gh = (args) => {
    calls.push(args)
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { repository: { pullRequest: { merged, closingIssuesReferences: { nodes: issues } } } } })
    }
    if (args[0] === 'issue' && args[1] === 'close') {
      if (args[2] === String(failOn)) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 403: Resource not accessible\n' })
      return ''
    }
    throw new Error(`意外的 gh 调用: ${args.join(' ')}`)
  }
  return { gh, calls }
}

test('PR 已合并：关掉还开着的关联 issue（含跨仓），已关的不再动，留言说明是合并伙伴补关', () => {
  const R = 'xindong/mivo-canvas-plugin'
  const { gh, calls } = fakeGh({ issues: [node(R, 1464, 'OPEN'), node(R, 1463, 'CLOSED'), node('PraiseZhu/other', 7, 'OPEN')] })
  const out = closeLinkedIssues({ repo: R, pr: 1949, gh })
  assert.deepEqual(out, { repo: R, pr: 1949, closed: [`${R}#1464`, 'PraiseZhu/other#7'], already_closed: [`${R}#1463`], failed: [] })
  const close = calls.filter((a) => a[0] === 'issue')
  assert.deepEqual(close.map((a) => [a[2], a[4]]), [['1464', R], ['7', 'PraiseZhu/other']])
  assert.ok(close[0].includes('completed'))
  assert.match(close[0].at(-1), /xindong\/mivo-canvas-plugin#1949 已合并.*由合并伙伴补关/)
})

test('PR 没合并：拒绝，不关任何 issue', () => {
  const { gh, calls } = fakeGh({ merged: false, issues: [node('o/r', 1, 'OPEN')] })
  assert.throws(() => closeLinkedIssues({ repo: 'o/r', pr: 2, gh }), (e) => e instanceof UsageError && /还没合并/.test(e.message))
  assert.equal(calls.filter((a) => a[0] === 'issue').length, 0)
})

test('一个 issue 关闭失败：记进 failed（带错误末行），其余照常关', () => {
  const { gh } = fakeGh({ issues: [node('o/r', 1, 'OPEN'), node('o/r', 2, 'OPEN')], failOn: 1 })
  const out = closeLinkedIssues({ repo: 'o/r', pr: 3, gh })
  assert.deepEqual(out.closed, ['o/r#2'])
  assert.deepEqual(out.failed, [{ ref: 'o/r#1', error: 'HTTP 403: Resource not accessible' }])
})

test('参数错：仓名和 PR 号不合格就拒绝', () => {
  const { gh } = fakeGh()
  assert.throws(() => closeLinkedIssues({ repo: 'bad', pr: 1, gh }), UsageError)
  assert.throws(() => closeLinkedIssues({ repo: 'o/r', pr: 0, gh }), UsageError)
})

test('operations.md 的合入后步骤写了补关命令，命令里的脚本路径存在', () => {
  const ops = readFileSync(join(root, 'docs/operations.md'), 'utf8')
  const section = ops.slice(ops.indexOf('### 合入后通知发起合并的会话'))
  assert.match(section, /node scripts\/close-linked-issues\.mjs <owner\/repo> <号>/)
  readFileSync(join(root, 'scripts/close-linked-issues.mjs'))
})
