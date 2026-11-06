// 用 App ID + 私钥换安装令牌。JWT 用 node:crypto 签，令牌只放内存缓存，到期前 5 分钟换新。
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { GitHubError } from './github.mjs'

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

export function toAppJwt({ appId, privateKey, nowSec }) {
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')
  return `${unsigned}.${signature}`
}

export function createTokenProvider({ appId, installationId, keyPath, privateKey, fetchImpl = fetch, now = () => Date.now(), baseUrl = 'https://api.github.com' }) {
  let cached = null
  return async function getToken() {
    if (cached && cached.expiresAt - 5 * 60_000 > now()) return cached.token
    const key = privateKey ?? readFileSync(keyPath, 'utf8')
    const jwt = toAppJwt({ appId, privateKey: key, nowSec: Math.floor(now() / 1000) })
    const path = `/app/installations/${installationId}/access_tokens`
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new GitHubError('POST', path, res.status, typeof data?.message === 'string' ? data.message.slice(0, 200) : '')
    cached = { token: data.token, expiresAt: Date.parse(data.expires_at) }
    return cached.token
  }
}
