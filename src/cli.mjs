// 命令入口：enqueue --file <json> | tick | status | unfreeze <owner/repo> | attest --repo --pr --head --kind --result --by
// 配置目录：--config <dir> 或 $PRAISE_MERGE_CONFIG，默认本仓 config/。状态目录：$PRAISE_MERGE_STATE。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from './policy.mjs'
import { createStore, selectStateDir } from './queue.mjs'
import { createClient } from './github.mjs'
import { createTokenProvider } from './app-token.mjs'
import { loadGates } from './gates/index.mjs'
import { loadLanes } from './lanes/index.mjs'
import { runTick, unfreezeLane } from './tick.mjs'
import { enqueueRequest } from './enqueue.mjs'
import { attest } from './attest.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export function createClientFactory(app, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const clients = new Map()
  return (repo) => {
    const owner = repo.split('/')[0].toLowerCase()
    const installationId = app.installations[owner]
    if (!installationId) throw new Error(`app.json 里没有 ${owner} 的安装 ID`)
    if (!clients.has(owner)) {
      const getToken = createTokenProvider({ appId: app.appId, installationId, keyPath: app.keyPath, fetchImpl, now })
      clients.set(owner, createClient({ getToken, fetchImpl, shadow: app.shadow }))
    }
    return clients.get(owner)
  }
}

export async function main(argv, { env = process.env, fetchImpl = fetch, now = Date.now, stdout = process.stdout } = {}) {
  const args = [...argv]
  const configFlag = args.indexOf('--config')
  const configDir = configFlag >= 0 ? args.splice(configFlag, 2)[1] : env.PRAISE_MERGE_CONFIG || join(repoRoot, 'config')
  const [command, ...rest] = args
  const store = createStore(selectStateDir(env))
  const print = (obj) => stdout.write(`${JSON.stringify(obj)}\n`)

  if (command === 'status') {
    const queue = store.loadQueue()
    print({ lanes: store.loadLanes(), items: queue.items.map(({ id, status, reason, after, authorizedAt, updatedAt }) => ({ id, status, reason, after, authorizedAt, updatedAt })) })
    return 0
  }
  if (command === 'unfreeze') {
    if (!rest[0]) throw new Error('用法: unfreeze <owner/repo>')
    print({ unfrozen: unfreezeLane(store, rest[0]) })
    return 0
  }
  if (command === 'attest') {
    // 写审查证据：用本机 gh（PraiseZhu），不读 App 配置
    const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
    print(attest({ repo: flag('repo'), pr: Number(flag('pr')), head: flag('head'), kind: flag('kind'), result: flag('result'), by: flag('by') }))
    return 0
  }
  if (command === 'tick' && store.isDisabled()) {
    // 停止开关先于读配置：配置坏了开关也有效
    store.appendLog({ type: 'disabled' }, now())
    print({ disabled: true, events: [] })
    return 0
  }

  const { app, policy } = readConfig(configDir)
  const clientFor = createClientFactory(app, { fetchImpl, now })

  if (command === 'enqueue') {
    const fileFlag = rest.indexOf('--file')
    if (fileFlag < 0 || !rest[fileFlag + 1]) throw new Error('用法: enqueue --file <request.json>')
    const request = JSON.parse(readFileSync(rest[fileFlag + 1], 'utf8'))
    const result = await enqueueRequest({ store, policy, clientFor, request, now: now() })
    print(result)
    return result.ok ? 0 : 2
  }
  if (command === 'tick') {
    const result = await runTick({ store, policy, gates: await loadGates(), lanes: await loadLanes(), clientFor, shadow: app.shadow, now: now() })
    print({ shadow: app.shadow, ...result })
    return 0
  }
  throw new Error(`未知命令: ${command ?? '(空)'}；可用: enqueue --file <json> | tick | status | unfreeze <owner/repo> | attest …`)
}
