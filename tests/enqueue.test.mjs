// SC2：请求校验与入队
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enqueueRequest } from '../src/enqueue.mjs'
import { SCHEMA } from '../src/request.mjs'
import { makeEnv, makeWorld, makePr, HEAD, REPO } from './helpers/fake-github.mjs'

const request = (overrides = {}) => ({
  schema: SCHEMA,
  session_id: 's1',
  authorized_at: new Date().toISOString(),
  authorization_text: '合并',
  prs: [{ repo: 'PraiseZhu/demo', number: 1, head_sha_at_auth: HEAD }],
  ...overrides,
})

async function enqueue(req, world) {
  const env = await makeEnv({ world })
  const result = await enqueueRequest({ store: env.store, policy: env.policy, clientFor: env.clientFor, request: req })
  return { result, env }
}

test('合法请求入队，status 能列出每个 PR', async () => {
  const { result, env } = await enqueue(request())
  assert.deepEqual(result, { ok: true, accepted: [`${REPO}#1`], rejected: [] })
  const [item] = env.store.loadQueue().items
  assert.equal(item.status, 'queued')
  assert.equal(item.authorizationText, '合并')
})

for (const [name, req, reason] of [
  ['缺 session_id', request({ session_id: undefined }), /missing_field: session_id/],
  ['schema 不对', request({ schema: 'praise-merge/request@2' }), /schema_mismatch/],
  ['authorized_at 不是时间', request({ authorized_at: 'yesterday' }), /authorized_at_not_iso8601/],
  ['依赖成环', request({ prs: [
    { repo: 'PraiseZhu/demo', number: 1, head_sha_at_auth: HEAD, after: ['PraiseZhu/demo#2'] },
    { repo: 'PraiseZhu/demo', number: 2, head_sha_at_auth: HEAD, after: ['PraiseZhu/demo#1'] },
  ] }), /after_cycle/],
]) {
  test(`整份拒收：${name}`, async () => {
    const { result, env } = await enqueue(req)
    assert.equal(result.ok, false)
    assert.match(result.reason, reason)
    assert.equal(env.store.loadQueue().items.length, 0)
  })
}

test('仓不在 policy、排除仓、作者不是 PraiseZhu：单个 PR 被拒收并给出原因', async () => {
  const world = makeWorld({ prs: { 1: makePr(), 3: makePr({ number: 3, user: { login: 'someone' } }) } })
  const { result } = await enqueue(request({ prs: [
    { repo: 'PraiseZhu/demo', number: 1, head_sha_at_auth: HEAD },
    { repo: 'PraiseZhu/other', number: 1, head_sha_at_auth: HEAD },
    { repo: 'makecindy/cindy', number: 9, head_sha_at_auth: HEAD },
    { repo: 'PraiseZhu/demo', number: 3, head_sha_at_auth: HEAD },
  ] }), world)
  assert.equal(result.ok, true)
  assert.deepEqual(result.accepted, [`${REPO}#1`])
  const reasons = Object.fromEntries(result.rejected.map((r) => [r.id, r.reason]))
  assert.equal(reasons['praisezhu/other#1'], 'repo_not_in_policy')
  assert.equal(reasons['makecindy/cindy#9'], 'repo_excluded')
  assert.match(reasons[`${REPO}#3`], /author 期望 PraiseZhu，实际 someone/)
})

test('依赖了被拒收的 PR，依赖方也不收', async () => {
  const world = makeWorld({ prs: { 1: makePr({ user: { login: 'someone' } }), 2: makePr({ number: 2 }) } })
  const { result } = await enqueue(request({ prs: [
    { repo: 'PraiseZhu/demo', number: 1, head_sha_at_auth: HEAD },
    { repo: 'PraiseZhu/demo', number: 2, head_sha_at_auth: HEAD, after: ['PraiseZhu/demo#1'] },
  ] }), world)
  assert.deepEqual(result.accepted, [])
  assert.match(result.rejected.find((r) => r.id === `${REPO}#2`).reason, /依赖 praisezhu\/demo#1 被拒收/)
})

test('依赖指向队列外、请求外的 PR：该 PR 被拒收', async () => {
  const { result } = await enqueue(request({ prs: [{ repo: 'PraiseZhu/demo', number: 1, head_sha_at_auth: HEAD, after: ['PraiseZhu/demo#99'] }] }))
  assert.match(result.rejected[0].reason, /after_unknown: praisezhu\/demo#99/)
})

test('入队阶段只发只读请求', async () => {
  const { env } = await enqueue(request())
  assert.deepEqual(env.fake.writes(), [])
})
