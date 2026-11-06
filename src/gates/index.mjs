// 门禁注册表。本目录下每个 *.mjs（index 除外）default 导出一个门禁或门禁数组：
//   { id, lanes: ['personal' | 'mivo', ...], check: async (ctx) => ({ ok, reason }) }
// 按目录自动加载：新增或替换门禁只加 / 删文件，不改本文件。id 重复直接报错。
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export async function loadGates(dir = here) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs').sort()
  const gates = []
  const seen = new Set()
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href)
    for (const gate of [mod.default].flat()) {
      if (!gate?.id || !Array.isArray(gate.lanes) || typeof gate.check !== 'function') throw new Error(`${file} 导出的门禁缺 id / lanes / check`)
      if (seen.has(gate.id)) throw new Error(`门禁 id 重复: ${gate.id}（${file}）`)
      seen.add(gate.id)
      gates.push(gate)
    }
  }
  return gates
}

export const selectLaneGates = (gates, lane) => gates.filter((g) => g.lanes.includes(lane))

// 依次跑完全部门禁（不短路），返回失败列表；门禁自身抛错按失败算。
export async function toGateFailures(gates, ctx) {
  const failures = []
  for (const gate of gates) {
    let result
    try {
      result = await gate.check(ctx)
    } catch (err) {
      result = { ok: false, reason: `gate_error: ${err.message}` }
    }
    if (!result?.ok) failures.push({ id: gate.id, reason: result?.reason ?? 'no_reason' })
  }
  return failures
}
