// 车道注册表。本目录下每个 *.mjs（index 除外）default 导出一个车道：
//   { id, process: async (env) => ({ status?, reason?, events?, stopLane? }), beforeItems?: async ({ repo, laneState, client, now }) => ({ events?, stopLane? }) }
// env = { item, repoPolicy, laneState, client, facts, gates, now, shadow }
// 按目录自动加载：替换车道只加 / 删文件，不改本文件。id 重复直接报错。
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export async function loadLanes(dir = here) {
  const lanes = new Map()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs').sort()) {
    const lane = (await import(pathToFileURL(join(dir, file)).href)).default
    if (!lane?.id || typeof lane.process !== 'function') throw new Error(`${file} 导出的车道缺 id / process`)
    if (lanes.has(lane.id)) throw new Error(`车道 id 重复: ${lane.id}（${file}）`)
    lanes.set(lane.id, lane)
  }
  return lanes
}
