// 队列与状态。目录默认 ~/.local/state/praise-merge/（不放 Syncthing 同步目录）。
// 写入一律「写临时文件 + rename」；tick / enqueue 共用一把目录锁，同一时刻只有一个进程改状态。
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 终态：不再处理
export const FINAL_STATUSES = new Set(['merged', 'expired', 'rejected', 'blocked_by_dependency', 'dequeued', 'closed'])

export function selectStateDir(env = process.env) {
  return env.PRAISE_MERGE_STATE || join(homedir(), '.local', 'state', 'praise-merge')
}

export function createStore(dir) {
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const file = (name) => join(dir, name)

  const readJson = (name, fallback) => {
    if (!existsSync(file(name))) return fallback
    return JSON.parse(readFileSync(file(name), 'utf8'))
  }
  const writeJson = (name, value) => {
    const tmp = `${file(name)}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(tmp, file(name))
  }

  return {
    dir,
    isDisabled: () => existsSync(file('DISABLED')),
    loadQueue: () => readJson('queue.json', { items: [] }),
    saveQueue: (q) => writeJson('queue.json', q),
    loadLanes: () => readJson('lanes.json', {}),
    saveLanes: (l) => writeJson('lanes.json', l),
    appendLog(record, now = Date.now()) {
      const day = new Date(now).toISOString().slice(0, 10)
      appendFileSync(join(dir, 'logs', `events-${day}.jsonl`), `${JSON.stringify({ at: new Date(now).toISOString(), ...record })}\n`)
    },
    // 目录锁：mkdir 原子；持锁进程已不在就回收
    acquireLock() {
      const lockDir = file('lock')
      try {
        mkdirSync(lockDir)
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        const pid = Number(readJsonSafe(join(lockDir, 'owner.json'))?.pid)
        if (pid && isAlive(pid)) return null
        rmSync(lockDir, { recursive: true, force: true })
        mkdirSync(lockDir)
      }
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }))
      return () => rmSync(lockDir, { recursive: true, force: true })
    },
  }
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}
