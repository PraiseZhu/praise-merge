#!/usr/bin/env node
// 合入后补关 PR 声明要关闭的 issue。由合并伙伴在处理 merged 事件时调用。
// 原因：xindong/mivo-canvas-plugin 合并后 GitHub 不按「Closes」自动关 issue（#1949 合入后 #1464 一直开着，
// PraiseZhu 亲手合的 #1553、#1663 也一样）。
// 用合并伙伴自己的 GitHub App 身份（#55，2026-11-21 用户定：自动化不用个人账号）：App 加了 Issues 读写，
// 两份安装都同意以后令牌才带这项权限（doctor 会核对）。不调用 gh，失败时也不退回个人登录。
//
// 用法：node scripts/close-linked-issues.mjs <owner/repo> <PR 号> [--config <dir>]
// 配置目录：--config、$PRAISE_MERGE_CONFIG，或本脚本所在仓的 config/（和 bin/praise-merge 一致）；在运行目录 ~/praise-merge-runtime 里跑就是线上配置。
// 输出一行 JSON：{ repo, pr, closed, already_closed, failed }。exit 0 全部处理完 / 1 有关闭失败或读不到 / 2 参数错或 PR 没合并。
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from '../src/policy.mjs'
import { createClientFactory } from '../src/cli.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){merged closingIssuesReferences(first:50){nodes{number state repository{nameWithOwner}}}}}}'

export class UsageError extends Error {}

const toComment = (repo, pr) => `${repo}#${pr} 已合并。PR 正文写了关闭这个 issue，但 GitHub 没有自动关闭，由合并伙伴补关。`

// clientFor：按仓返回 App 客户端（src/cli.mjs 的 createClientFactory）。issue 在别的 owner 的仓时用那个 owner 的安装
export async function closeLinkedIssues({ repo, pr, clientFor }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new UsageError(`仓应为 owner/name，实际 ${repo}`)
  if (!Number.isInteger(pr) || pr < 1) throw new UsageError(`PR 号应为正整数，实际 ${pr}`)
  const [owner, name] = repo.split('/')
  const data = await clientFor(repo).graphql(QUERY, { owner, name, number: pr })
  const found = data?.repository?.pullRequest
  if (!found) throw new UsageError(`查不到 ${repo}#${pr}`)
  if (!found.merged) throw new UsageError(`${repo}#${pr} 还没合并，不关 issue`)
  const result = { repo, pr, closed: [], already_closed: [], failed: [] }
  for (const issue of found.closingIssuesReferences?.nodes ?? []) {
    const issueRepo = issue.repository.nameWithOwner
    const ref = `${issueRepo}#${issue.number}`
    if (issue.state !== 'OPEN') {
      result.already_closed.push(ref)
      continue
    }
    try {
      const client = clientFor(issueRepo)
      await client.request('POST', `/repos/${issueRepo}/issues/${issue.number}/comments`, { body: toComment(repo, pr) })
      await client.request('PATCH', `/repos/${issueRepo}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' })
      result.closed.push(ref)
    } catch (err) {
      result.failed.push({ ref, error: String(err.message).trim().split('\n').pop().slice(0, 200) })
    }
  }
  return result
}

export async function main(argv, { env = process.env, fetchImpl = fetch, stdout = process.stdout } = {}) {
  const args = [...argv]
  const configFlag = args.indexOf('--config')
  const configDir = configFlag >= 0 ? args.splice(configFlag, 2)[1] : env.PRAISE_MERGE_CONFIG || join(root, 'config')
  const [repo, pr] = args
  const { app } = readConfig(configDir)
  const result = await closeLinkedIssues({ repo, pr: Number(pr), clientFor: createClientFactory(app, { fetchImpl }) })
  stdout.write(`${JSON.stringify(result)}\n`)
  return result.failed.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (err) => {
      process.stderr.write(`close-linked-issues: ${err.message}\n`)
      process.exitCode = err instanceof UsageError ? 2 : 1
    },
  )
}
