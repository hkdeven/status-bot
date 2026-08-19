import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../state.js'
import { zohoAccessToken } from '../auth/zoho.js'
import { clock } from '../render.js'

const API = 'https://projectsapi.zoho.com'
const MODULES = ['project', 'task', 'bug', 'milestone']
const DEFAULT_WATCH = ['Expected Release Date', 'tags', 'status']
const projectCachePath = join(root, '.tokens', 'zoho-projects.json')
const fieldSnapshotPath = join(root, '.tokens', 'zoho-task-fields.json')

// Zoho allows 100 requests per endpoint per two minutes, so anything per task is
// rationed and anything that can be fetched per project is fetched per project.
const CAPS = { tagLookups: 60, commentLookups: 30, projectPages: 3 }

function makeClient (token, warnings) {
  return async function get (path, params = {}, { soft = false } = {}) {
    const url = new URL(API + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } })
    if (res.status === 204) return null
    const text = await res.text()
    if (!res.ok) {
      const throttled = text.includes('THROTTLES_LIMIT_EXCEEDED')
      const message = throttled
        ? `Zoho throttled ${path.replace(/\d{10,}/g, '<id>')}, some detail is missing from this digest`
        : `Zoho ${path.replace(/\d{10,}/g, '<id>')} returned ${res.status}`
      if (!soft) throw new Error(message)
      if (!warnings.includes(message)) warnings.push(message)
      return null
    }
    try { return JSON.parse(text) } catch { return null }
  }
}

function readJson (path) {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

async function resolveProjects (get, portalId, wantedIds) {
  const cache = readJson(projectCachePath)
  if (wantedIds.some(id => !cache[id])) {
    for (let page = 0; page < 6 && wantedIds.some(id => !cache[id]); page++) {
      const list = await get(`/api/v3/portal/${portalId}/projects`, {
        index: String(page * 100 + 1), range: '100'
      }, { soft: true })
      if (!Array.isArray(list) || !list.length) break
      for (const p of list) cache[String(p.id)] = p.name
    }
    writeFileSync(projectCachePath, JSON.stringify(cache))
  }
  return cache
}

function stripHtml (html) {
  return String(html || '')
    // Zoho stores mentions as zp[@zpuser#<id>#<name>]zp
    .replace(/zp\[@zpuser#\d+#([^\]]+)\]zp/g, '@$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// Zoho date custom fields come back as "08-21-2026 12:00:00 AM".
const tidy = v => String(v).replace(/\s+12:00:00\s*AM$/i, '')

// One activity row per changed field, so a single edit can appear eight times.
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

function describe (g) {
  const what = g.a.activity_state === 'copy' ? 'created' : `${g.a.activity_state}d`.replace('eed', 'ed')
  const fields = g.fields.size ? ` (${[...g.fields].slice(0, 4).join(', ')}${g.fields.size > 4 ? ', ...' : ''})` : ''
  const times = g.count > 1 ? `, ${g.count} edits` : ''
  return `${g.who} ${what} ${g.a.activity} **${g.a.name}**${fields}${times}`
}

// Status and custom fields come from the project task list, one call per project.
async function fetchProjectTasks (get, portalId, projectIds) {
  const byTask = new Map()
  for (const projectId of projectIds) {
    for (let page = 0; page < CAPS.projectPages; page++) {
      const res = await get(`/restapi/portal/${portalId}/projects/${projectId}/tasks/`, {
        index: String(page * 100 + 1), range: '100'
      }, { soft: true })
      const tasks = res?.tasks || []
      for (const t of tasks) {
        const custom = {}
        for (const f of t.custom_fields || []) custom[f.label_name] = f.value
        byTask.set(String(t.id_string || t.id), {
          name: t.name, projectId: String(projectId), status: t.status?.name || '', custom
        })
      }
      if (tasks.length < 100) break
    }
  }
  return byTask
}

// Tags are not on any list endpoint and the tags API needs a scope we do not
// hold, so they are read one task at a time, in batches, up to the cap.
async function fetchTags (get, portalId, targets, warnings) {
  const out = new Map()
  const list = targets.slice(0, CAPS.tagLookups)
  if (targets.length > list.length) {
    warnings.push(`Tags read for ${list.length} of ${targets.length} tasks, the rest are grouped as untagged to stay inside the Zoho rate limit`)
  }
  const batch = 5
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async t => {
      const res = await get(`/api/v3/portal/${portalId}/projects/${t.projectId}/tasks/${t.taskId}`, {}, { soft: true })
      const task = Array.isArray(res) ? res[0] : (res?.tasks?.[0] || res)
      if (task?.tags) out.set(t.taskId, task.tags.map(x => x.name).sort())
    }))
  }
  return out
}

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']

// Sprint tags read like "21 AUGUST SPRINT", so they sort by date rather than
// alphabetically. Anything unparseable falls to the end, in name order.
function sprintOrder (tag, year) {
  const m = /(\d{1,2})\s+([A-Z]+)/i.exec(tag)
  if (!m) return Number.MAX_SAFE_INTEGER
  const month = MONTHS.indexOf(m[2].toUpperCase())
  if (month < 0) return Number.MAX_SAFE_INTEGER
  return new Date(year, month, Number(m[1])).getTime()
}

async function fetchComments (get, portalId, targets, since) {
  const out = []
  const batch = 5
  const list = targets.slice(0, CAPS.commentLookups)
  for (let i = 0; i < list.length; i += batch) {
    const results = await Promise.all(list.slice(i, i + batch).map(async t => {
      const res = await get(`/api/v3/portal/${portalId}/projects/${t.projectId}/tasks/${t.taskId}/comments`, {}, { soft: true })
      return (res?.comments || [])
        .filter(c => new Date(c.created_time) >= since)
        .map(c => ({ ...c, taskName: t.name, projectName: t.projectName, isMine: !!t.isMine }))
    }))
    out.push(...results.flat())
  }
  return out.sort((a, b) => new Date(b.created_time) - new Date(a.created_time))
}

function diffFields (current, snapshot, watch) {
  const changes = []
  for (const [taskId, now] of current) {
    const before = snapshot[taskId]
    for (const field of watch) {
      if (field === 'tags') {
        if (!now.tags) continue
        const wasTags = before?.tags
        if (!wasTags) {
          if (now.tags.length) changes.push({ ...now, taskId, field, text: `tags are ${now.tags.join(', ')}`, isNew: true })
          continue
        }
        const added = now.tags.filter(x => !wasTags.includes(x))
        const removed = wasTags.filter(x => !now.tags.includes(x))
        if (added.length || removed.length) {
          const parts = []
          if (added.length) parts.push(`added ${added.join(', ')}`)
          if (removed.length) parts.push(`removed ${removed.join(', ')}`)
          changes.push({ ...now, taskId, field, text: `tags ${parts.join(', ')}` })
        }
        continue
      }
      const nowValue = field === 'status' ? now.status : now.custom?.[field]
      const wasValue = before ? (field === 'status' ? before.status : before.custom?.[field]) : undefined
      if (nowValue == null || nowValue === '') continue
      if (wasValue === undefined) {
        changes.push({ ...now, taskId, field, text: `${field} is ${tidy(nowValue)}`, isNew: true })
      } else if (nowValue !== wasValue) {
        changes.push({ ...now, taskId, field, text: `${field} now ${tidy(nowValue)}, was ${wasValue ? tidy(wasValue) : 'empty'}` })
      }
    }
  }
  return changes
}

export async function collectZoho ({ since, config, commit }) {
  if (!process.env.ZOHO_REFRESH_TOKEN) {
    return { title: 'Zoho Projects', configured: false, setupHint: 'Add ZOHO_* values to .env.' }
  }

  const warnings = []
  const get = makeClient(await zohoAccessToken(), warnings)
  const portalId = process.env.ZOHO_PORTAL_ID || String((await get('/api/v3/portals'))[0].id)

  const userList = (await get(`/restapi/portal/${portalId}/users/`))?.users || []
  const users = Object.fromEntries(userList.map(u => [String(u.id), u.name]))
  const myEmail = (config.outlook?.yourAddresses?.[0] || '').toLowerCase()
  const me = userList.find(u => (u.email || '').toLowerCase() === myEmail)

  const activities = []
  for (const module of MODULES) {
    const res = await get(`/api/v3/portal/${portalId}/activities`, {
      module, action: 'updated', index: '1', range: '100'
    }, { soft: true })
    for (const a of res?.activities || []) {
      if (new Date(a.action_time) >= since) activities.push(a)
    }
  }
  activities.sort((a, b) => new Date(b.action_time) - new Date(a.action_time))

  const names = await resolveProjects(get, portalId, [...new Set(activities.map(a => String(a.project_id)))])
  const excluded = config.zoho?.excludeProjects || []
  const watch = config.zoho?.watchFields || DEFAULT_WATCH
  const visible = activities.filter(a => !excluded.includes(names[String(a.project_id)]))

  const body = []
  const attention = []

  // Everything below works off the tasks that actually moved in this window.
  const taskTargets = new Map()
  for (const a of visible) {
    if (a.activity !== 'task') continue
    taskTargets.set(String(a.id), {
      taskId: String(a.id),
      projectId: String(a.project_id),
      name: a.name,
      projectName: names[String(a.project_id)] || `project ${a.project_id}`,
      tagChanged: false
    })
  }
  for (const a of visible) {
    if (a.activity === 'task' && a.field?.field_name === 'tags') taskTargets.get(String(a.id)).tagChanged = true
  }

  const targets = [...taskTargets.values()]
  const projectIds = [...new Set(targets.map(t => t.projectId))]
  const projectTasks = await fetchProjectTasks(get, portalId, projectIds)
  const tags = await fetchTags(get, portalId, targets, warnings)

  // Activity is grouped by sprint tag, since that is how the work is planned.
  // Everything without one lands in a single bucket at the end.
  const sprintPattern = new RegExp(config.zoho?.sprintTagPattern || 'SPRINT', 'i')
  const UNTAGGED = 'No sprint tag'
  const sprintOf = taskId => (tags.get(taskId) || []).find(t => sprintPattern.test(t)) || UNTAGGED
  const otherTags = taskId => (tags.get(taskId) || []).filter(t => !sprintPattern.test(t))

  if (visible.length) {
    const bySprint = new Map()
    for (const a of visible) {
      const key = a.activity === 'task' ? sprintOf(String(a.id)) : UNTAGGED
      if (!bySprint.has(key)) bySprint.set(key, [])
      bySprint.get(key).push(a)
    }
    const year = since.getFullYear()
    const sprints = [...bySprint.keys()].sort((a, b) => {
      if (a === UNTAGGED) return 1
      if (b === UNTAGGED) return -1
      return sprintOrder(a, year) - sprintOrder(b, year) || a.localeCompare(b)
    })

    const movers = [...new Set(visible.map(a => users[String(a.user?.id)]).filter(Boolean))]
    const edits = [...bySprint.values()].reduce((n, list) => n + rollup(list, users).length, 0)
    const named = sprints.filter(x => x !== UNTAGGED).length
    body.push(`${edits} edit${edits === 1 ? '' : 's'} across ${named} sprint${named === 1 ? '' : 's'} by ${movers.join(', ') || 'unknown'}.`)
    body.push('')

    for (const sprint of sprints) {
      const list = bySprint.get(sprint)
      const rolled = rollup(list, users)
      body.push(`### ${sprint} (${rolled.length} edit${rolled.length === 1 ? '' : 's'})`)
      body.push('')
      for (const g of rolled.slice(0, 15)) {
        const target = taskTargets.get(String(g.a.id))
        const project = target?.projectName || names[String(g.a.project_id)] || 'unknown project'
        const extra = otherTags(String(g.a.id))
        const extraText = extra.length ? `, tagged ${extra.join(', ')}` : ''
        body.push(`- ${describe(g)} [${project}${extraText}] (${clock(g.latest)})`)
      }
      if (rolled.length > 15) body.push(`- plus ${rolled.length - 15} more`)
      body.push('')
    }
  }

  const current = new Map()
  for (const t of targets) {
    const fields = projectTasks.get(t.taskId)
    if (!fields && !tags.has(t.taskId)) continue
    current.set(t.taskId, {
      name: t.name,
      project: t.projectName,
      status: fields?.status || '',
      custom: fields?.custom || {},
      ...(tags.has(t.taskId) ? { tags: tags.get(t.taskId) } : {})
    })
  }

  const snapshot = readJson(fieldSnapshotPath)
  const known = diffFields(current, snapshot, watch).filter(c => !c.isNew)
  if (known.length) {
    const byTask = new Map()
    for (const c of known) {
      if (!byTask.has(c.taskId)) byTask.set(c.taskId, { name: c.name, project: c.project, texts: [] })
      byTask.get(c.taskId).texts.push(c.text)
    }
    const rows = [...byTask.values()]
    body.push('### Field changes')
    body.push('')
    for (const r of rows.slice(0, 25)) body.push(`- **${r.name}** (${r.project}): ${r.texts.join('; ')}`)
    if (rows.length > 25) body.push(`- plus ${rows.length - 25} more`)
    body.push('')
    const releases = known.filter(c => /release/i.test(c.field))
    if (releases.length) {
      attention.push(`${releases.length} expected release date${releases.length === 1 ? '' : 's'} moved: ${[...new Set(releases.map(c => c.name))].slice(0, 4).join(', ')}`)
    }
  } else if (!Object.keys(snapshot).length && current.size) {
    body.push('### Field changes')
    body.push('')
    body.push(commit
      ? `Baseline recorded for ${current.size} task${current.size === 1 ? '' : 's'}. Changes to ${watch.join(', ')} appear from the next digest onward.`
      : `No baseline yet. The 07:00 run records one, then changes to ${watch.join(', ')} show up here.`)
    body.push('')
  }

  if (commit && current.size) {
    const merged = { ...snapshot }
    for (const [taskId, value] of current) merged[taskId] = { ...merged[taskId], ...value }
    writeFileSync(fieldSnapshotPath, JSON.stringify(merged))
  }

  const comments = await fetchComments(get, portalId, targets, since)
  if (comments.length) {
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
    const flagged = comments.filter(c => tagsMe(c))
    if (flagged.length) {
      attention.push(`${flagged.length} Zoho comment${flagged.length === 1 ? '' : 's'} tag you: ${[...new Set(flagged.map(c => c.taskName))].slice(0, 4).join(', ')}`)
    }
  }

  const mine = (await get(`/restapi/portal/${portalId}/mytasks/`, {
    index: '1', range: '100', status: 'open'
  }, { soft: true }))?.tasks || []
  if (mine.length) {
    const touched = mine.filter(t => t.last_updated_time_long && new Date(t.last_updated_time_long) >= since)
    body.push('### Your open tasks')
    body.push('')
    body.push(`${mine.length} open, ${touched.length} touched in this window.`)
    for (const t of touched.slice(0, 15)) {
      body.push(`- **${t.name}** (${t.project?.name || 'no project'}, ${t.status?.name || t.status || 'no status'}, ${clock(t.last_updated_time_long)})`)
    }
    body.push('')
    if (touched.length) {
      attention.push(`${touched.length} Zoho task${touched.length === 1 ? '' : 's'} assigned to you changed: ${touched.slice(0, 5).map(t => t.name).join(', ')}`)
    }
  }

  if (warnings.length) {
    body.push('### Gaps in this digest')
    body.push('')
    for (const w of warnings) body.push(`- ${w}`)
    body.push('')
  }

  return { title: 'Zoho Projects', configured: true, body, attention }
}
