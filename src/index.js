#!/usr/bin/env node
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { root, readState, writeState, loadConfig, parseSince } from './state.js'
import { render, stamp } from './render.js'
import { collectGithub } from './sources/github.js'
import { collectOutlook } from './sources/outlook.js'
import { collectTrello } from './sources/trello.js'
import { collectZoho } from './sources/zoho.js'

const envPath = join(root, '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const args = process.argv.slice(2)
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const has = name => args.includes(`--${name}`)

const config = loadConfig()
const state = readState()
const sinceRaw = flag('since')
const since = parseSince(sinceRaw, state.lastRun || new Date(Date.now() - 86400e3).toISOString())
const generatedAt = new Date()

// The field snapshot updates on any --write-state run, so it can be seeded over
// a wide window, but only a run without --since advances the digest window.
const commit = has('write-state')
const advanceWindow = commit && !sinceRaw
const only = flag('only')?.split(',').map(s => s.trim())
const sources = [
  ['github', collectGithub],
  ['outlook', collectOutlook],
  ['trello', collectTrello],
  ['zoho', collectZoho]
].filter(([name]) => !only || only.includes(name))

const sections = []
for (const [name, collect] of sources) {
  try {
    sections.push(await collect({ since, config, state, commit }))
  } catch (err) {
    sections.push({ title: name, configured: true, error: err.message })
  }
}

const markdown = render({ since, generatedAt, sections })
const file = join(root, 'digests', `${stamp(generatedAt)}.md`)
writeFileSync(file, markdown)
writeFileSync(join(root, 'digests', 'latest.md'), markdown)

// Only a scheduled run advances the window, so on demand runs never eat tomorrow's news.
if (advanceWindow) {
  writeState({ ...state, lastRun: generatedAt.toISOString() })
}

if (has('quiet')) {
  console.log(file)
} else {
  console.log(markdown)
  console.log(`\nSaved to ${file}`)
}
