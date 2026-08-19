import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../state.js'

const cachePath = join(root, '.tokens', 'ms.json')
const SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access'

const authority = () =>
  `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0`

function readCache () {
  if (!existsSync(cachePath)) return null
  try { return JSON.parse(readFileSync(cachePath, 'utf8')) } catch { return null }
}

function writeCache (json) {
  writeCacheRaw({
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000
  })
}

function writeCacheRaw (data) {
  writeFileSync(cachePath, JSON.stringify(data, null, 2))
}

async function post (path, params) {
  const res = await fetch(`${authority()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  })
  return res.json()
}

export async function graphAccessToken () {
  const cached = readCache()
  if (!cached) throw new Error('Outlook is not signed in yet. Run: node src/auth/msgraph.js --login')
  if (cached.expiresAt > Date.now() + 60e3) return cached.accessToken

  const json = await post('/token', {
    client_id: process.env.MS_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: cached.refreshToken,
    scope: SCOPE
  })
  if (!json.access_token) {
    throw new Error(`Outlook sign in expired (${json.error_description || json.error}). Run: node src/auth/msgraph.js --login`)
  }
  writeCache(json)
  return json.access_token
}

export async function deviceLogin () {
  const start = await post('/devicecode', { client_id: process.env.MS_CLIENT_ID, scope: SCOPE })
  if (!start.device_code) throw new Error(JSON.stringify(start))

  console.log(`\nGo to ${start.verification_uri}`)
  console.log(`Enter this code: ${start.user_code}`)
  console.log(`Waiting, the code is good for ${Math.round(start.expires_in / 60)} minutes.\n`)

  const interval = (start.interval || 5) * 1000
  const deadline = Date.now() + start.expires_in * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))
    const json = await post('/token', {
      client_id: process.env.MS_CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: start.device_code
    })
    if (json.access_token) {
      writeCache(json)
      console.log('Signed in. Token cached in .tokens/ms.json')
      return
    }
    if (json.error && json.error !== 'authorization_pending' && json.error !== 'slow_down') {
      throw new Error(json.error_description || json.error)
    }
  }
  throw new Error('The device code expired before sign in completed.')
}

if (process.argv.includes('--login')) {
  const envPath = join(root, '.env')
  if (existsSync(envPath)) process.loadEnvFile(envPath)
  await deviceLogin()
}
