import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const statePath = join(root, 'state.json')

export function readState () {
  if (!existsSync(statePath)) return {}
  try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return {} }
}

export function writeState (next) {
  writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n')
}

export function loadConfig () {
  return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
}

// Turns --since=24h | 3d | today | 2026-08-18 | ISO into a Date.
export function parseSince (raw, fallbackISO) {
  if (!raw) return new Date(fallbackISO)
  if (raw === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }
  const rel = /^(\d+)([hd])$/.exec(raw)
  if (rel) {
    const ms = Number(rel[1]) * (rel[2] === 'h' ? 3600e3 : 86400e3)
    return new Date(Date.now() - ms)
  }
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Cannot read --since=${raw}`)
  return parsed
}
