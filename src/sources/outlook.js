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

// Notification mail from a platform the digest already read is an echo, not news.
const PLATFORM_SENDERS = {
  trello: /@(.*\.)?trello\.com$/i,
  zoho: /@(.*\.)?zoho(projects|corp)?\.(com|eu|in|com\.au)$/i,
  github: /@(.*\.)?github\.com$/i
}

// Help desk mail is addressed to him and unread, so it looks urgent to every
// heuristic, but a queue of submitted tickets is a list to skim, not an inbox
// of people waiting on a reply.
const DEFAULT_HELPDESK = ['zohodesk\\.com', 'helpdesk@', 'servicedesk@']

// GitHub subjects carry the repo, as in "[owner/repo] Something happened (#12)".
const repoFromSubject = subject => /\[([\w.-]+\/[\w.-]+)\]/.exec(subject || '')?.[1]

export function platformOf (message) {
  const from = addr(message.from)
  for (const [platform, pattern] of Object.entries(PLATFORM_SENDERS)) {
    if (pattern.test(from)) return platform
  }
  return null
}

// Returns 'echo' to drop it, 'uncovered' to show it, or null when it is not
// platform mail at all. GitHub mail about an untracked repo is never an echo,
// since nothing else in the digest reports that repo.
export function echoVerdict (message, coverage = {}) {
  const platform = platformOf(message)
  if (!platform) return null
  if (!coverage[platform]?.covered) return 'uncovered'
  if (platform === 'github') {
    const repo = repoFromSubject(message.subject)
    const tracked = (coverage.github.repos || []).map(r => r.toLowerCase())
    if (!repo || !tracked.includes(repo.toLowerCase())) return 'uncovered'
  }
  return 'echo'
}

function classify (m, mine) {
  const from = addr(m.from)
  const to = (m.toRecipients || []).map(addr)
  const cc = (m.ccRecipients || []).map(addr)
  const direct = to.some(a => mine.includes(a))
  // mentionsPreview is not selectable on this endpoint, so a direct address is
  // the strongest signal the message is aimed at him.

  if (AUTOMATED.test(from) || AUTOMATED.test(m.from?.emailAddress?.name || '')) return 'noise'
  if (m.flag?.flagStatus === 'flagged') return 'needsYou'
  if (m.importance === 'high' && direct) return 'needsYou'
  if (direct && !m.isRead) return 'needsYou'
  if (direct) return 'fyi'
  if (cc.some(a => mine.includes(a))) return 'fyi'
  return 'noise'
}

function line (m) {
  const who = m.from?.emailAddress?.name || addr(m.from) || 'unknown sender'
  const preview = (m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return `- **${m.subject || '(no subject)'}**, ${who} (${clock(m.receivedDateTime)})${m.isRead ? '' : ' [unread]'}\n  ${preview}`
}

const ticketNumber = preview => /#(\d{3,})/.exec(preview || '')?.[1]
const submitter = subject => /^(.*?)\s+has submitted a new ticket/i.exec(subject || '')?.[1]

export async function collectOutlook ({ since, config, coverage = {} }) {
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
    $select: 'subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,importance,flag,bodyPreview,webLink,conversationId',
    $top: String(config.outlook?.maxMessages || 100),
    $orderby: 'receivedDateTime desc'
  })
  const messages = res.value || []

  const buckets = { needsYou: [], fyi: [], noise: [], echo: [], uncovered: [], helpdesk: [] }
  const suppress = config.outlook?.suppressCoveredNotifications !== false
  const helpdesk = new RegExp((config.outlook?.helpdeskSenders || DEFAULT_HELPDESK).join('|'), 'i')
  for (const m of messages) {
    const verdict = suppress ? echoVerdict(m, coverage) : null
    if (verdict === 'echo') { buckets.echo.push(m); continue }
    if (verdict === 'uncovered') { buckets.uncovered.push(m); continue }
    if (helpdesk.test(addr(m.from))) { buckets.helpdesk.push(m); continue }
    buckets[classify(m, mine)].push(m)
  }

  const body = []
  const attention = []

  body.push(`${messages.length} message${messages.length === 1 ? '' : 's'} in the inbox for this window: ${buckets.needsYou.length} need you, ${buckets.fyi.length} for information, ${buckets.helpdesk.length} help desk, ${buckets.noise.length} automated, ${buckets.echo.length} already reported above.`)
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

  if (buckets.helpdesk.length) {
    body.push(`**Help desk queue**: ${buckets.helpdesk.length} new ticket${buckets.helpdesk.length === 1 ? '' : 's'}`)
    for (const m of buckets.helpdesk.slice(0, 12)) {
      const num = ticketNumber(m.bodyPreview)
      const who = submitter(m.subject)
      const label = who ? `${who}` : (m.subject || '(no subject)')
      const gist = (m.bodyPreview || '').replace(/\s+/g, ' ')
        .replace(/^.*?has been submitted by .*?\.\s*/i, '')
        .replace(/^#\d+\s*/, '').slice(0, 90)
      body.push(`- ${num ? `#${num} ` : ''}${label}: ${gist}`)
    }
    if (buckets.helpdesk.length > 12) body.push(`- plus ${buckets.helpdesk.length - 12} more`)
    body.push('')
  }

  if (buckets.uncovered.length) {
    body.push('**Platform mail not covered elsewhere**')
    for (const m of buckets.uncovered.slice(0, 15)) {
      const why = platformOf(m) === 'github' ? 'repo is not in config.json' : 'that source did not report'
      body.push(`- ${m.subject || '(no subject)'}, ${m.from?.emailAddress?.name || addr(m.from)} (${clock(m.receivedDateTime)}), ${why}`)
    }
    if (buckets.uncovered.length > 15) body.push(`- plus ${buckets.uncovered.length - 15} more`)
    body.push('')
    const repos = [...new Set(buckets.uncovered.filter(m => platformOf(m) === 'github')
      .map(m => repoFromSubject(m.subject)).filter(Boolean))]
    if (repos.length) {
      attention.push(`GitHub mail about ${repos.length} repo${repos.length === 1 ? '' : 's'} the digest does not track: ${repos.join(', ')}`)
    }
  }

  if (buckets.echo.length) {
    const byPlatform = new Map()
    for (const m of buckets.echo) {
      const p = platformOf(m)
      byPlatform.set(p, (byPlatform.get(p) || 0) + 1)
    }
    const parts = [...byPlatform.entries()].map(([p, n]) => `${p} ${n}`).join(', ')
    body.push(`**Suppressed as duplicates**: ${buckets.echo.length} notification email${buckets.echo.length === 1 ? '' : 's'} (${parts}). Those changes are in the sections above.`)
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
