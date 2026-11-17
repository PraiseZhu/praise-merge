// Mivo 受保护路径的维护者自动放行不挂 merge-ready，也没有模型审查报告。
// 只有审查机的明确通知 + 当前 head 成功检查才替代标签；普通成功检查不能替代标签。
import { AUTHOR, MIVO_INTEGRATION_REVIEW_CHECK, MIVO_INTEGRATION_BRANCH } from './policy.mjs'

const REPO = 'xindong/mivo-canvas-plugin'
const REVIEW_BOT = 'praisebuild[bot]'
const REVIEW_APP_ID = 15368
const isReviewBot = (user) => user?.login === REVIEW_BOT && user.type === 'Bot'

function isBypassComment(comment, repo, number) {
  if (!isReviewBot(comment.user)) return false
  if (comment.html_url !== `https://github.com/${repo}/pull/${number}#issuecomment-${comment.id}`) return false
  const body = comment.body ?? ''
  const marker = body.match(/<!-- review-pr:product-gate kind=arch issue=(https:\/\/github\.com\/[^\s]+) -->/)
  if (!marker || !marker[1].startsWith(`https://github.com/${repo}/issues/`)) return false
  if (!/^\d+$/.test(marker[1].slice(`https://github.com/${repo}/issues/`.length))) return false
  return /^本 PR 改了受保护路径（[^\n]+），作者是维护者，按规则自动放行（自动审查不审这类改动，审查机直接把 review-pr 写为通过）；/.test(body)
}

function isBypassIssue(issue, repo, number) {
  if (!isReviewBot(issue.user) || issue.pull_request) return false
  if (issue.html_url !== `https://github.com/${repo}/issues/${issue.number}`) return false
  if (!issue.title?.startsWith(`维护者确认 · PR #${number} `)) return false
  const body = issue.body ?? ''
  return body.includes('<!-- review-pr:signoff-mode=notice -->')
    && /^\*\*protected\*\* — 改动受保护路径 .+\(作者为维护者，自动放行\)$/m.test(body)
    && body.includes(`\n### PR\nhttps://github.com/${repo}/pull/${number}\n`)
    && body.includes('本 issue 只是通知：作者是维护者，受保护路径改动按规则自动放行，不需要回复')
}

export async function toMaintainerBypassVerdict({ facts, pr, repo }) {
  const deny = (reason, readFailed = false) => ({ ok: false, reason: `auto_intake_maintainer_bypass: ${reason}`, readFailed })
  // 当前 Mivo 车道允许的作者中，只有 PraiseZhu 是维护者。通知不扩大作者名单或其他仓的权限。
  if (repo !== REPO || pr.user?.login !== AUTHOR) return deny('不是 Mivo 维护者 PR')
  const context = MIVO_INTEGRATION_BRANCH.test(pr.base?.ref ?? '') ? MIVO_INTEGRATION_REVIEW_CHECK : 'review-pr'
  try {
    const check = (await facts.checkStates(pr.head.sha)).get(context)
    if (check?.kind !== 'check' || check.state !== 'success' || check.appId !== REVIEW_APP_ID || check.headSha !== pr.head.sha) return deny(`当前 head 的 ${context} 未成功或写入方/head 不符`)
    if (check.reviewTitle !== '受保护路径:作者为维护者,自动放行'
      || !/(?:^|[\s:])author-maintainer:praisezhu(?:$|\s)/.test(check.reviewSummary)) return deny('当前 head 的检查输出不是受保护路径维护者自动放行')
    const comments = await facts.issueComments()
    if (comments.some((c) => isBypassComment(c, repo, pr.number))) return { ok: true }
    const issues = await facts.maintainerIssues()
    if (issues.some((issue) => isBypassIssue(issue, repo, pr.number))) return { ok: true }
    return deny('没有审查机的受保护路径维护者自动放行通知')
  } catch (err) {
    return deny(`读不到完整放行证据（${err.message}）`, true)
  }
}
