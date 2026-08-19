import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../state.js'

const cachePath = join(root, '.tokens', 'zoho.json')

export async function zohoAccessToken () {
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (cached.expiresAt > Date.now() + 60e3) return cached.accessToken
    } catch { /* fall through and refresh */ }
  }

  const host = process.env.ZOHO_ACCOUNTS_HOST || 'https://accounts.zoho.com'
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN
  })
  const res = await fetch(`${host}/oauth/v2/token`, { method: 'POST', body })
  const json = await res.json()
  if (!json.access_token) throw new Error(`Zoho refresh failed: ${JSON.stringify(json)}`)

  writeFileSync(cachePath, JSON.stringify({
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000
  }))
  return json.access_token
}
