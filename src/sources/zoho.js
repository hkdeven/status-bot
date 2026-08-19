import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../state.js'
import { zohoAccessToken } from '../auth/zoho.js'
import { clock } from '../render.js'

const API = 'https://projectsapi.zoho.com'
const MODULES = ['project', 'task', 'bug', 'milestone']
const projectCachePath = join(root, '.tokens', 'zoho-projects.json')

async function get (token, path, params = {}) {
  const url = new URL(API + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } })
  if (!res.ok) throw new Error(`Zoho ${path} returned ${res.status}`)
  return res.json()
}

function loadProjectCache () {
  if (!existsSync(projectCachePath)) return {}
  try { return JSON.parse(readFileSync(projectCachePath, 'utf8')) } catch { return {} }
}

// Names are only resolved for projects that actually showed up, then cached,
// so a portal with hundreds of contracts does not cost hundreds of calls.
async function resolveProjects (token, portalId, wantedIds) {
  const cache = loadProjectCache()
  const missing = wantedIds.filter(id => !cache[id])
  if (missing.length) {
    for (let page = 0; page < 6 && missing.some(id => !cache[id]); page++) {
      const list = await get(token, `/api/v3/portal/${portalId}/projects`, {
        index: String(page * 100 + 1), range: '100'
      })
      if (!Array.isArray(list) || !list.length) break
      for (const p of list) cache[String(p.id)] = p.name
    }
    writeFileSync(projectCachePath, JSON.stringify(cache))
  }
  return cache
}

// Zoho logs one activity per field, so a single edit can appear eight times.
// Roll them up per item, per person, per action.
function rollup (activities, users) {
  const groups = new Map()
  for (const a of activities) {
    const key = `${a.id}|${a.user?.id}|${a.activity_state}`
    if (!groups.has(key)) {
      groups.set(key, { a, who: users[String(a.user?.id)] || 'someone', fields: new Set(), count: 0, latest: a.action_time })
    }
    const g = groups.get(key)
    g.count++
    if (a.field?.field_name) g.fields.add(a.field.field_name)
    if (new Date(a.action_time) > new Date(g.latest)) g.latest = a.action_time
  }
  return [...groups.values()].sort((x, y) => new Date(y.latest) - new Date(x.latest))
}

function stripHtml (html) {
  return String(html || '')
    // Zoho stores mentions as zp[@zpuser#<id>#<name>]zp
    .replace(/zp\[@zpuser#\d+#([^\]]+)\]zp/g, '@$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// Comments live outside the activity feed, one endpoint per task, so only tasks
// that actually moved in this window get looked up.
async function fetchComments (token, portalId, targets, since) {
  const out = []
  const batchSize = 5
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize)
    const results = await Promise.all(batch.map(async t => {
      try {
        const res = await get(token, `/api/v3/portal/${portalId}/projects/${t.projectId}/tasks/${t.taskId}/comments`)
        return (res.comments || [])
          .filter(c => new Date(c.created_time) >= since)
          .map(c => ({ ...c, taskName: t.name, projectName: t.projectName, taskId: t.taskId, isMine: !!t.isMine }))
      } catch {
        return []
      }
    }))
    out.push(...results.flat())
  }
  return out.sort((a, b) => new Date(b.created_time) - new Date(a.created_time))
}

function describe (g) {
  const what = g.a.activity_state === 'copy' ? 'created' : `${g.a.activity_state}d`.replace('eed', 'ed')
  const fields = g.fields.size ? ` (${[...g.fields].slice(0, 4).join(', ')}${g.fields.size > 4 ? ', ...' : ''})` : ''
  const times = g.count > 1 ? `, ${g.count} edits` : ''
  return `${g.who} ${what} ${g.a.activity} **${g.a.name}**${fields}${times}`
}

export async function collectZoho ({ since, config }) {
  if (!process.env.ZOHO_REFRESH_TOKEN) {
    return { title: 'Zoho Projects', configured: false, setupHint: 'Add ZOHO_* values to .env.' }
  }

  const token = await zohoAccessToken()
  const portalId = process.env.ZOHO_PORTAL_ID ||
    String((await get(token, '/api/v3/portals'))[0].id)

  const userList = (await get(token, `/restapi/portal/${portalId}/users/`)).users || []
  const users = Object.fromEntries(userList.map(u => [String(u.id), u.name]))
  const me = userList.find(u => (u.email || '').toLowerCase() ===
    (config.outlook?.yourAddresses?.[0] || '').toLowerCase())

  const activities = []
  for (const module of MODULES) {
    const res = await get(token, `/api/v3/portal/${portalId}/activities`, {
      module, action: 'updated', index: '1', range: '100'
    })
    for (const a of res.activities || []) {
      if (new Date(a.action_time) >= since) activities.push(a)
    }
  }
  activities.sort((a, b) => new Date(b.action_time) - new Date(a.action_time))

  const names = await resolveProjects(token, portalId, [...new Set(activities.map(a => String(a.project_id)))])

  const excluded = config.zoho?.excludeProjects || []
  const body = []
  const attention = []

  if (activities.length) {
    const byProject = new Map()
    for (const a of activities) {
      const key = names[String(a.project_id)] || `project ${a.project_id}`
      if (excluded.includes(key)) continue
      if (!byProject.has(key)) byProject.set(key, [])
      byProject.get(key).push(a)
    }
    const movers = [...new Set(activities.map(a => users[String(a.user?.id)]).filter(Boolean))]
    const edits = [...byProject.values()].reduce((n, list) => n + rollup(list, users).length, 0)
    body.push(`${edits} edit${edits === 1 ? '' : 's'} across ${byProject.size} project${byProject.size === 1 ? '' : 's'} by ${movers.join(', ') || 'unknown'}.`)
    body.push('')
    for (const [project, list] of byProject) {
      body.push(`### ${project}`)
      body.push('')
      const rolled = rollup(list, users)
      for (const g of rolled.slice(0, 12)) body.push(`- ${describe(g)} (${clock(g.latest)})`)
      if (rolled.length > 12) body.push(`- plus ${rolled.length - 12} more`)
      body.push('')
    }
  }

  // Comments on anything that moved, plus anything on your own plate.
  const commentTargets = new Map()
  for (const a of activities) {
    if (a.activity !== 'task') continue
    const projectName = names[String(a.project_id)] || `project ${a.project_id}`
    if (excluded.includes(projectName)) continue
    commentTargets.set(String(a.id), {
      projectId: String(a.project_id), taskId: String(a.id), name: a.name, projectName
    })
  }

  // Tasks assigned to you, so the digest says what is on your plate, not just what moved.
  const mine = (await get(token, `/restapi/portal/${portalId}/mytasks/`, {
    index: '1', range: '100', status: 'open'
  })).tasks || []
  if (mine.length) {
    const touched = mine.filter(t => t.last_updated_time_long && new Date(t.last_updated_time_long) >= since)
    for (const t of touched) {
      if (!t.project?.id_string || !t.id_string) continue
      commentTargets.set(String(t.id_string), {
        projectId: String(t.project.id_string), taskId: String(t.id_string),
        name: t.name, projectName: t.project.name, isMine: true
      })
    }
    const overdue = mine.filter(t => t.end_date_long && new Date(t.end_date_long) < new Date())
    body.push('### Your open tasks')
    body.push('')
    body.push(`${mine.length} open, ${touched.length} touched in this window.`)
    for (const t of touched.slice(0, 15)) {
      const status = t.status?.name || t.status || 'no status'
      body.push(`- **${t.name}** (${t.project?.name || 'no project'}, ${status}, ${clock(t.last_updated_time_long)})`)
    }
    body.push('')
    if (touched.length) {
      attention.push(`${touched.length} Zoho task${touched.length === 1 ? '' : 's'} assigned to you changed: ${touched.slice(0, 5).map(t => t.name).join(', ')}`)
    }
    if (overdue.length) {
      attention.push(`${overdue.length} Zoho task${overdue.length === 1 ? '' : 's'} assigned to you ${overdue.length === 1 ? 'is' : 'are'} past the due date`)
    }
  }

  const targets = [...commentTargets.values()].slice(0, 60)
  const comments = await fetchComments(token, portalId, targets, since)
  if (comments.length) {
    // Mentions carry the numeric user id, which beats matching on a name.
    const tagsMe = c => me && new RegExp(`zpuser#${me.id}#`).test(String(c.comment || ''))
    body.push('### Comments')
    body.push('')
    for (const c of comments.slice(0, 20)) {
      const text = stripHtml(c.comment)
      const mark = tagsMe(c) ? ' [tags you]' : ''
      body.push(`- **${c.taskName}** (${c.projectName}), ${c.created_by?.full_name || 'someone'} (${clock(c.created_time)})${mark}: "${text.length > 220 ? text.slice(0, 220) + '...' : text}"`)
    }
    if (comments.length > 20) body.push(`- plus ${comments.length - 20} more`)
    body.push('')

    const flagged = comments.filter(c => tagsMe(c) || c.isMine)
    if (flagged.length) {
      attention.push(`${flagged.length} Zoho comment${flagged.length === 1 ? '' : 's'} name you or land on your tasks: ${[...new Set(flagged.slice(0, 4).map(c => c.taskName))].join(', ')}`)
    }
  }

  return { title: 'Zoho Projects', configured: true, body, attention }
}
