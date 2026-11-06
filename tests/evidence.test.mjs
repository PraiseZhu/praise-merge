// #3：patch-id、证据门禁、attest
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toPatchId } from '../src/patch-id.mjs'
import { attest, toAttestDescription } from '../src/attest.mjs'
import { runTick } from '../src/tick.mjs'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { makeEnv, makeWorld, makePr, makeTempDir, seedItem, evidenceStatus, authStatus, passingRun, HEAD, DIFF, REPO } from './helpers/fake-github.mjs'

// SC1 ---------------------------------------------------------------------------------------------
function gitRepo() {
  const root = makeTempDir()
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  const write = (name, lines) => writeFileSync(join(root, name), `${lines.join('\n')}\n`)
  return { root, git, write }
}
const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`)

test('SC1 只追了 base（无冲突）patch-id 不变；PR 多改一行就变', () => {
  const { git, write } = gitRepo()
  write('a.txt', lines(40))
  write('b.py', ['def f():', '    return 1'])
  git('add', '.'); git('commit', '-qm', 'base')
  git('switch', '-qc', 'feature')
  write('a.txt', lines(40, { 30: 'changed in PR' }))
  write('b.py', ['def f():', '    return 2'])
  git('commit', '-qam', 'pr change')
  const before = toPatchId(git('diff', 'main...feature'))

  git('switch', '-q', 'main')
  write('a.txt', ['new first line', ...lines(40)]) // 远离 PR 改动的上下文，只让行号整体后移
  git('commit', '-qam', 'main moves on')
  git('switch', '-q', 'feature')
  git('merge', '-q', '--no-edit', 'main') // 等同 update-branch
  const afterSync = toPatchId(git('diff', 'main...feature'))
  assert.equal(afterSync, before)

  write('b.py', ['def f():', '    return 3'])
  git('commit', '-qam', 'one more change')
  assert.notEqual(toPatchId(git('diff', 'main...feature')), before)
})

test('SC1 缩进变化也算改动（Python / YAML 里缩进就是语义）', () => {
  const a = toPatchId('diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-x\n+    y\n')
  const b = toPatchId('diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-x\n+  y\n')
  assert.notEqual(a, b)
  assert.throws(() => toPatchId(''), /不是 git diff 文本/)
})

// SC2–SC4、SC6 -------------------------------------------------------------------------------------
const PATCH = toPatchId(DIFF)
const tick = (env) => runTick({ ...env, now: Date.now() })
const item = (env) => env.store.loadQueue().items[0]
const mergeCalls = (env) => env.fake.calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/merge'))

async function runWith(worldOverrides, { e2e = 'n_a', seenHeads } = {}) {
  const env = await makeEnv({ world: makeWorld(worldOverrides), shadow: false })
  env.policy.repos[REPO].e2e = e2e
  seedItem(env.store, seenHeads ? { seenHeads } : {})
  await tick(env)
  return env
}

test('SC2 证据齐全（授权与 gpt-review 都是 success、PraiseZhu 写、patch 一致）且 e2e 为 n_a 时合并', async () => {
  const env = await runWith({ statuses: { [HEAD]: [authStatus(PATCH), evidenceStatus(PATCH)] } })
  assert.equal(mergeCalls(env).length, 1)
})

for (const [name, statuses, reason, e2e] of [
  ['没有 status', [], /gpt-review: missing/],
  ['结论是 failure', [evidenceStatus(PATCH, { state: 'failure' })], /gpt-review=failure/],
  ['写入方不是 PraiseZhu', [evidenceStatus(PATCH, { creator: { login: 'github-actions[bot]' } })], /写入方期望 PraiseZhu，实际 github-actions\[bot\]/],
  ['patch-id 不一致', [evidenceStatus('f'.repeat(40))], /gpt-review: patch_changed/],
  ['policy 要求 e2e 却缺', [evidenceStatus(PATCH)], /e2e: missing/, 'required'],
]) {
  test(`SC3 证据门禁不放行：${name}`, async () => {
    const env = await runWith({ statuses: { [HEAD]: statuses } }, { e2e })
    assert.equal(mergeCalls(env).length, 0)
    assert.match(item(env).reason, reason)
  })
}

test('SC2 policy 要求 e2e 且 e2e 证据齐全时合并', async () => {
  const e2e = evidenceStatus(PATCH, { id: 101, context: 'praise-merge/e2e' })
  const env = await runWith({ statuses: { [HEAD]: [authStatus(PATCH), evidenceStatus(PATCH), e2e] } }, { e2e: 'required' })
  assert.equal(mergeCalls(env).length, 1)
})

test('SC4 只追了 main：head 变了、patch 没变，旧 head 上的证据仍然有效', async () => {
  const NEW = 'b'.repeat(40)
  const env = await runWith({
    prs: { 1: makePr({ head: { sha: NEW } }) },
    checks: { [NEW]: [passingRun('verify')] },
    statuses: { [HEAD]: [authStatus(PATCH), evidenceStatus(PATCH)] },
  }, { seenHeads: [HEAD] })
  assert.equal(mergeCalls(env).length, 1)
  assert.equal(mergeCalls(env)[0].body.sha, NEW)
})

test('SC4 追 main 时解决了冲突、patch 变了：旧证据作废，reason 为 patch_changed', async () => {
  const NEW = 'b'.repeat(40)
  const env = await runWith({
    prs: { 1: makePr({ head: { sha: NEW } }) },
    checks: { [NEW]: [passingRun('verify')] },
    statuses: { [HEAD]: [evidenceStatus(PATCH)] },
    diffs: { 1: DIFF.replace('+new', '+resolved') },
  }, { seenHeads: [HEAD] })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /patch_changed/)
})

test('新 head 上的 failure 不会被旧 head 上的 success 盖过', async () => {
  const NEW = 'b'.repeat(40)
  const env = await runWith({
    prs: { 1: makePr({ head: { sha: NEW } }) },
    checks: { [NEW]: [passingRun('verify')] },
    statuses: { [HEAD]: [evidenceStatus(PATCH)], [NEW]: [evidenceStatus(PATCH, { state: 'failure' })] },
  }, { seenHeads: [HEAD] })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /gpt-review=failure/)
})

test('SC6 占位实现已删除；影子模式下证据齐全的 PR 产生 would_merge', async () => {
  const gatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gates')
  assert.equal(existsSync(join(gatesDir, 'evidence-stub.mjs')), false)
  const env = await makeEnv({ world: makeWorld({ statuses: { [HEAD]: [authStatus(PATCH), evidenceStatus(PATCH)] } }), shadow: true })
  seedItem(env.store)
  const { events } = await tick(env)
  assert.deepEqual(events.map((e) => e.type), ['would_merge'])
})

// #16 授权证据 ------------------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000
const fullEvidence = (auth = authStatus(PATCH)) => [auth, evidenceStatus(PATCH), evidenceStatus(PATCH, { id: 101, context: 'praise-merge/e2e' })]

test('#16 SC1 三样证据（授权、GPT 单审、e2e）都在且有效：合并', async () => {
  const env = await runWith({ statuses: { [HEAD]: fullEvidence() } }, { e2e: 'required' })
  assert.equal(mergeCalls(env).length, 1)
})

for (const [name, statuses, reason] of [
  ['缺授权', fullEvidence().slice(1), /authorization: missing（praise-merge\/authorization）/],
  ['缺 GPT 单审', [fullEvidence()[0], fullEvidence()[2]], /gpt-review: missing/],
  ['缺 e2e', fullEvidence().slice(0, 2), /e2e: missing/],
  ['授权写入方不是 PraiseZhu', fullEvidence(authStatus(PATCH, { creator: { login: 'someone' } })), /authorization: 写入方期望 PraiseZhu，实际 someone/],
  ['授权结论不是 success', fullEvidence(authStatus(PATCH, { state: 'failure' })), /authorization=failure/],
]) {
  test(`#16 SC1 三样证据缺一样不合：${name}`, async () => {
    const env = await runWith({ statuses: { [HEAD]: statuses } }, { e2e: 'required' })
    assert.equal(mergeCalls(env).length, 0)
    assert.match(item(env).reason, reason)
  })
}

test('#16 SC2 授权写入超过 7 天：过期，不合', async () => {
  const old = authStatus(PATCH, { created_at: new Date(Date.now() - 7 * DAY - 60_000).toISOString() })
  const env = await runWith({ statuses: { [HEAD]: fullEvidence(old) } }, { e2e: 'required' })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /authorization: expired/)
})

test('#16 SC2 授权写入 6 天：仍有效', async () => {
  const recent = authStatus(PATCH, { created_at: new Date(Date.now() - 6 * DAY).toISOString() })
  const env = await runWith({ statuses: { [HEAD]: fullEvidence(recent) } }, { e2e: 'required' })
  assert.equal(mergeCalls(env).length, 1)
})

test('#16 SC2 授权缺写入时间：当作过期', async () => {
  const env = await runWith({ statuses: { [HEAD]: fullEvidence(authStatus(PATCH, { created_at: undefined })) } }, { e2e: 'required' })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /authorization: expired/)
})

test('#16 SC2 PR 内容变了：授权随 patch-id 失效，不合', async () => {
  const env = await runWith({ statuses: { [HEAD]: fullEvidence(authStatus('e'.repeat(40))) } }, { e2e: 'required' })
  assert.equal(mergeCalls(env).length, 0)
  assert.match(item(env).reason, /authorization: patch_changed/)
})

test('#16 SC3 attest --kind authorization：写 praise-merge/authorization，格式与另两类相同', () => {
  const { gh, calls } = fakeGh()
  const out = attest({ repo: 'PraiseZhu/demo', pr: 1, head: HEAD, kind: 'authorization', result: 'pass', by: 'session-s1', gh })
  assert.equal(out.context, 'praise-merge/authorization')
  assert.equal(out.description, `patch:${PATCH} by:session-s1`)
  assert.ok(calls.find((a) => a.includes('POST')).includes('context=praise-merge/authorization'))
})

for (const kind of ['authorization', 'gpt-review', 'e2e']) {
  test(`#16 同名 check run 遮住新 head 上的 ${kind} 证据：拒合，不回退去用旧 head 上的 success`, async () => {
    const NEW = 'b'.repeat(40)
    const env = await runWith({
      prs: { 1: makePr({ head: { sha: NEW } }) },
      checks: { [NEW]: [passingRun('verify'), { ...passingRun(`praise-merge/${kind}`, 7) }] },
      statuses: { [HEAD]: fullEvidence(), [NEW]: [evidenceStatus(PATCH, { id: 200, context: `praise-merge/${kind}`, state: 'failure' })] },
    }, { e2e: 'required', seenHeads: [HEAD] })
    assert.equal(mergeCalls(env).length, 0)
    assert.match(item(env).reason, new RegExp(`${kind}: 当前证据被同名 check run 遮住`))
  })
}

// SC5 ---------------------------------------------------------------------------------------------
function fakeGh({ heads = [HEAD, HEAD], diff = DIFF } = {}) {
  const calls = []
  const queue = [...heads]
  const gh = (args) => {
    calls.push(args)
    if (args.includes('--jq')) return `${queue.shift()}\n`
    if (args.includes('Accept: application/vnd.github.diff')) return diff
    if (args.includes('POST')) return '{}'
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  return { gh, calls }
}

test('SC5 attest 写出的 status 格式正确，description 不超过 140 字符；fail 写成 failure', () => {
  const { gh, calls } = fakeGh()
  const out = attest({ repo: 'PraiseZhu/demo', pr: 1, head: HEAD, kind: 'gpt-review', result: 'pass', by: 'gpt-5.5 xhigh', gh })
  assert.equal(out.patch, PATCH)
  const post = calls.find((a) => a.includes('POST'))
  assert.ok(post.includes(`repos/PraiseZhu/demo/statuses/${HEAD}`))
  assert.ok(post.includes('state=success'))
  assert.ok(post.includes('context=praise-merge/gpt-review'))
  assert.ok(post.includes(`description=patch:${PATCH} by:gpt-5.5_xhigh`))

  const failed = attest({ repo: 'PraiseZhu/demo', pr: 1, head: HEAD, kind: 'e2e', result: 'fail', by: 'x', gh: fakeGh().gh })
  assert.equal(failed.state, 'failure')
  assert.equal(failed.context, 'praise-merge/e2e')
  assert.ok(toAttestDescription(PATCH, 'y'.repeat(500)).length <= 140)
})

test('attest 拒绝写证据：PR 在审查后有新提交，或读 diff 期间有新提交', () => {
  const NEW = 'b'.repeat(40)
  assert.throws(() => attest({ repo: 'PraiseZhu/demo', pr: 1, head: HEAD, kind: 'gpt-review', result: 'pass', by: 'x', gh: fakeGh({ heads: [NEW] }).gh }), /PR 已有新提交/)
  const racing = fakeGh({ heads: [HEAD, NEW] })
  assert.throws(() => attest({ repo: 'PraiseZhu/demo', pr: 1, head: HEAD, kind: 'gpt-review', result: 'pass', by: 'x', gh: racing.gh }), /读取 diff 期间 PR 有新提交/)
  assert.equal(racing.calls.filter((a) => a.includes('POST')).length, 0)
  assert.throws(() => attest({ repo: 'PraiseZhu/demo', pr: 1, head: 'abc', kind: 'gpt-review', result: 'pass', by: 'x', gh: fakeGh().gh }), /--head 应为 40 位/)
  assert.throws(() => attest({ repo: 'PraiseZhu/demo', pr: 1, head: HEAD, kind: 'lint', result: 'pass', by: 'x', gh: fakeGh().gh }), /--kind/)
})
