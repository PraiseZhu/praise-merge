#!/usr/bin/env node
// 上线前和出问题时跑的自检：私钥、配置、令牌、安装范围逐项 pass / fail。不输出私钥或令牌。
// 用法：node scripts/doctor.mjs [--config <dir>]；全部 pass 退出 0，否则退出 1。
import { statSync, realpathSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from '../src/policy.mjs'
import { createTokenProvider } from '../src/app-token.mjs'

// 与 GitHub 上 App 设置一致（2026-11-06 核对）；多了或少了都算 fail
export const EXPECTED_PERMISSIONS = {
  actions: 'read', administration: 'read', checks: 'read', contents: 'write',
  merge_queues: 'write', metadata: 'read', pull_requests: 'write', statuses: 'read',
}

export async function runDoctor({ configDir, fetchImpl = fetch, home = homedir(), now = () => Date.now() }) {
  const results = []
  const check = (name, ok, detail = '') => results.push({ name, ok, detail })

  let config
  try {
    config = readConfig(configDir)
    check('config', true, `app_id=${config.app.appId}，policy ${Object.keys(config.policy.repos).length} 个仓，shadow=${config.app.shadow}`)
  } catch (err) {
    check('config', false, err.message)
    return results
  }

  const keyPath = config.app.keyPath
  if (!existsSync(keyPath)) {
    check('key_exists', false, `找不到私钥文件: ${keyPath}`)
    return results
  }
  check('key_exists', true, keyPath)
  const mode = statSync(keyPath).mode & 0o777
  check('key_mode_600', mode === 0o600, `期望 600，实际 ${mode.toString(8)}`)
  const syncedRoot = join(home, 'AI-Agent')
  const real = realpathSync(keyPath)
  const inSynced = real === syncedRoot || real.startsWith(syncedRoot + sep) || keyPath.startsWith(syncedRoot + sep)
  check('key_not_synced', !inSynced, inSynced ? `私钥在同步目录 ${syncedRoot} 下` : '不在 ~/AI-Agent 下')

  for (const [owner, installationId] of Object.entries(config.app.installations)) {
    const name = `installation_${owner}`
    try {
      let granted = null
      const recordingFetch = async (url, init) => {
        const res = await fetchImpl(url, init)
        if (url.endsWith('/access_tokens') && res.ok) granted = (await res.clone().json()).permissions ?? {}
        return res
      }
      const getToken = createTokenProvider({ appId: config.app.appId, installationId, keyPath, fetchImpl: recordingFetch, now })
      const token = await getToken()
      const diff = Object.keys({ ...EXPECTED_PERMISSIONS, ...granted }).filter((k) => EXPECTED_PERMISSIONS[k] !== granted[k])
      check(`${name}_permissions`, diff.length === 0, diff.length ? `与期望不同: ${diff.map((k) => `${k} 期望 ${EXPECTED_PERMISSIONS[k] ?? '无'} 实际 ${granted[k] ?? '无'}`).join('，')}` : '8 项与期望一致')
      const res = await fetchImpl('https://api.github.com/installation/repositories?per_page=100', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
      const repos = new Set(((await res.json()).repositories ?? []).map((r) => r.full_name.toLowerCase()))
      const missing = Object.keys(config.policy.repos).filter((r) => r.split('/')[0] === owner && !repos.has(r))
      check(`${name}_covers_policy`, missing.length === 0, missing.length ? `App 没装到: ${missing.join(', ')}` : `policy 里 ${owner} 的仓都在安装范围内`)
    } catch (err) {
      check(name, false, err.message)
    }
  }
  return results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--config')
  const configDir = i >= 0 ? process.argv[i + 1] : process.env.PRAISE_MERGE_CONFIG || join(dirname(fileURLToPath(import.meta.url)), '..', 'config')
  runDoctor({ configDir }).then((results) => {
    for (const r of results) process.stdout.write(`${r.ok ? 'pass' : 'fail'}  ${r.name}${r.detail ? `  ${r.detail}` : ''}\n`)
    process.exitCode = results.every((r) => r.ok) ? 0 : 1
  }, (err) => {
    process.stderr.write(`doctor: ${err.message}\n`)
    process.exitCode = 1
  })
}
