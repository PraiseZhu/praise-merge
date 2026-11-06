// SC11：仓里不放私钥、安装令牌或 JWT 形态的字面量
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATTERNS = [new RegExp(['BEGIN (RSA )?PRIV', 'ATE KEY'].join('')), new RegExp(['gh', 's_[A-Za-z0-9]{20}'].join('')), new RegExp(['ey', 'J[A-Za-z0-9_-]{10,}\\.'].join(''))]

test('受版本管理的文件里没有私钥 / 令牌字面量', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const re of PATTERNS) assert.doesNotMatch(text, re, `${file} 命中 ${re}`)
  }
})
