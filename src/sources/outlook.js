import { graphAccessToken } from '../auth/msgraph.js'
import { clock } from '../render.js'

const GRAPH = 'https://graph.microsoft.com/v1.0'

async function get (token, path, params = {}) {
  const url = new URL(GRAPH + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Graph ${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const addr = r => (r?.emailAddress?.address || '').toLowerCase()
const AUTOMATED = /(no-?reply|do-?not-?reply|notification|newsletter|mailer|bounce|postmaster|marketing|alerts?@)/i

function classify (m, mine) {
  const from = addr(m.from)
  const to = (m.toRecipients || []).map(addr)
  const cc = (m.ccRecipients || []).map(addr)
  const direct = to.some(a => mine.includes(a))
  const mentioned = m.mentionsPreview?.isMentioned

  if (AUTOMATED.test(from) || AUTOMATED.test(m.from?.emailAddress?.name || '')) return 'noise'
  if (m.flag?.flagStatus === 'flagged') return 'needsYou'
  if (m.importance === 'high' && (direct || mentioned)) return 'needsYou'
  if (direct && !m.isRead) return 'needsYou'
  if (mentioned) return 'needsYou'
  if (direct) return 'fyi'
  if (cc.some(a => mine.includes(a))) return 'fyi'
  return 'noise'
}

function line (m) {
  const who = m.from?.emailAddress?.name || addr(m.from) || 'unknown sender'
  const preview = (m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return `- **${m.subject || '(no subject)'}**, ${who} (${clock(m.receivedDateTime)})${m.isRead ? '' : ' [unread]'}\n  ${preview}`
}

export async function collectOutlook ({ since, config }) {
  if (!process.env.MS_CLIENT_ID) {
    return { title: 'Email (Outlook)', configured: false, setupHint: 'Add MS_CLIENT_ID and MS_TENANT_ID to .env.' }
  }

  let token
  try {
    token = await graphAccessToken()
  } catch (err) {
    return { title: 'Email (Outlook)', configured: false, setupHint: err.message }
  }

  const mine = (config.outlook?.yourAddresses || []).map(a => a.toLowerCase())
  const me = await get(token, '/me', { $select: 'displayName,mail,userPrincipalName' })
  for (const a of [me.mail, me.userPrincipalName]) {
    if (a && !mine.includes(a.toLowerCase())) mine.push(a.toLowerCase())
  }

  const res = await get(token, '/me/mailFolders/inbox/messages', {
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $select: 'subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,importance,flag,bodyPreview,webLink,mentionsPreview,conversationId',
    $top: String(config.outlook?.maxMessages || 100),
    $orderby: 'receivedDateTime desc'
  })
  const messages = res.value || []

  const buckets = { needsYou: [], fyi: [], noise: [] }
  for (const m of messages) buckets[classify(m, mine)].push(m)

  const body = []
  const attention = []

  body.push(`${messages.length} message${messages.length === 1 ? '' : 's'} in the inbox for this window: ${buckets.needsYou.length} need you, ${buckets.fyi.length} for information, ${buckets.noise.length} automated.`)
  body.push('')

  if (buckets.needsYou.length) {
    body.push('**Needs a reply or a decision**')
    for (const m of buckets.needsYou) body.push(line(m))
    body.push('')
    attention.push(`${buckets.needsYou.length} email${buckets.needsYou.length === 1 ? '' : 's'} addressed to you: ${buckets.needsYou.slice(0, 5).map(m => m.subject || '(no subject)').join('; ')}`)
  }

  if (buckets.fyi.length) {
    body.push('**For information**')
    for (const m of buckets.fyi.slice(0, 20)) {
      body.push(`- ${m.subject || '(no subject)'}, ${m.from?.emailAddress?.name || addr(m.from)} (${clock(m.receivedDateTime)})`)
    }
    if (buckets.fyi.length > 20) body.push(`- plus ${buckets.fyi.length - 20} more`)
    body.push('')
  }

  if (buckets.noise.length) {
    const bySender = new Map()
    for (const m of buckets.noise) {
      const who = m.from?.emailAddress?.name || addr(m.from) || 'unknown'
      bySender.set(who, (bySender.get(who) || 0) + 1)
    }
    const top = [...bySender.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    body.push(`**Automated**: ${top.map(([who, n]) => `${who} (${n})`).join(', ')}`)
    body.push('')
  }

  return { title: 'Email (Outlook)', configured: true, body, attention }
}
