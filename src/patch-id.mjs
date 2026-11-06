// PR 自身改动的指纹。思路同 git patch-id：只看改了什么，不看改在第几行。
// 去掉 index 行和 hunk 头里的行号，按文件分块、按路径排序后取 sha256 前 40 位。
// 空白照原样计入（Python / YAML 里缩进就是语义），只去掉行尾的 \r。
// 只追了 base、且 base 的改动不挨着 PR 的改动时，指纹不变；PR 多改一个字符，或 base 改到了 PR 改动的上下文，
// 指纹就变，证据作废、要重审（宁可多审一次，也不放过没审过的内容）。
import { createHash } from 'node:crypto'

export function toPatchId(diffText) {
  if (typeof diffText !== 'string' || !diffText.startsWith('diff --git ')) throw new Error('不是 git diff 文本，无法计算 patch-id')
  const blocks = diffText.split(/^(?=diff --git )/m).map((block) => {
    const lines = block.replace(/\n$/, '').split('\n').map((line) => line.replace(/\r$/, ''))
    const header = lines[0]
    const body = lines.slice(1)
      .filter((line) => !line.startsWith('index '))
      .map((line) => (line.startsWith('@@') ? line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, '@@') : line))
    return { header, text: [header, ...body].join('\n') }
  })
  blocks.sort((a, b) => (a.header < b.header ? -1 : a.header > b.header ? 1 : 0))
  return createHash('sha256').update(blocks.map((b) => b.text).join('\n')).digest('hex').slice(0, 40)
}
