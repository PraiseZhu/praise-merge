#!/usr/bin/env node
// 合入后补关 PR 声明要关闭的 issue。由合并伙伴在处理 merged 事件时调用。
// 原因：xindong/mivo-canvas-plugin 合并后 GitHub 不按「Closes」自动关 issue（#1949 合入后 #1464 一直开着，
// PraiseZhu 亲手合的 #1553、#1663 也一样），而 App 没有 issues 写权限。所以和 attest 一样用调用者本机的 gh（PraiseZhu），
// 不碰 App 私钥，也不读 app.json。
//
// 用法：node scripts/close-linked-issues.mjs <owner/repo> <PR 号>
// 输出一行 JSON：{ repo, pr, closed, already_closed, failed }。exit 0 全部处理完 / 1 有关闭失败 / 2 参数错或 PR 没合并。
import { fileURLToPath } from 'node:url'
import { runGh } from '../src/attest.mjs'

const QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){merged closingIssuesReferences(first:50){nodes{number state repository{nameWithOwner}}}}}}'

export class UsageError extends Error {}

export function closeLinkedIssues({ repo, pr, gh = runGh }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new UsageError(`仓应为 owner/name，实际 ${repo}`)
  if (!Number.isInteger(pr) || pr < 1) throw new UsageError(`PR 号应为正整数，实际 ${pr}`)
  const [owner, name] = repo.split('/')
  const data = JSON.parse(gh(['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]))
  const found = data?.data?.repository?.pullRequest
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
      gh(['issue', 'close', String(issue.number), '-R', issueRepo, '--reason', 'completed', '-c',
        `${repo}#${pr} 已合并。PR 正文写了关闭这个 issue，但 GitHub 没有自动关闭，由合并伙伴补关。`])
      result.closed.push(ref)
    } catch (err) {
      result.failed.push({ ref, error: String(err.stderr || err.message).trim().split('\n').pop().slice(0, 200) })
    }
  }
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repo, pr] = process.argv.slice(2)
  try {
    const result = closeLinkedIssues({ repo, pr: Number(pr) })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.failed.length ? 1 : 0
  } catch (err) {
    process.stderr.write(`close-linked-issues: ${err.message}\n`)
    process.exitCode = err instanceof UsageError ? 2 : 1
  }
}
