import { ago, clock } from '../render.js'

const API = 'https://api.trello.com/1'

async function get (path, params = {}) {
  const url = new URL(API + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('key', process.env.TRELLO_KEY)
  url.searchParams.set('token', process.env.TRELLO_TOKEN)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Trello ${path} returned ${res.status}`)
  return res.json()
}

const ACTION_FILTER = [
  'createCard', 'copyCard', 'deleteCard', 'updateCard', 'commentCard',
  'addMemberToCard', 'removeMemberFromCard', 'addAttachmentToCard',
  'updateCheckItemStateOnCard', 'createList', 'addChecklistToCard'
].join(',')

function describe (a) {
  const who = a.memberCreator?.fullName || a.memberCreator?.username || 'someone'
  const card = a.data?.card?.name
  switch (a.type) {
    case 'createCard':
      return `${who} added **${card}** to ${a.data?.list?.name || 'a list'}`
    case 'copyCard':
      return `${who} copied a card into **${card}**`
    case 'deleteCard':
      return `${who} deleted a card`
    case 'commentCard': {
      const text = (a.data?.text || '').replace(/\s+/g, ' ').trim()
      return `${who} commented on **${card}**: "${text.length > 140 ? text.slice(0, 140) + '...' : text}"`
    }
    case 'addMemberToCard':
      return `${who} put someone on **${card}**`
    case 'removeMemberFromCard':
      return `${who} took someone off **${card}**`
    case 'addAttachmentToCard':
      return `${who} attached ${a.data?.attachment?.name || 'a file'} to **${card}**`
    case 'addChecklistToCard':
      return `${who} added checklist ${a.data?.checklist?.name || ''} to **${card}**`.replace('  ', ' ')
    case 'updateCheckItemStateOnCard':
      return `${who} ${a.data?.checkItem?.state === 'complete' ? 'ticked' : 'unticked'} ${a.data?.checkItem?.name} on **${card}**`
    case 'createList':
      return `${who} created list ${a.data?.list?.name}`
    case 'updateCard': {
      if (a.data?.listBefore && a.data?.listAfter) {
        return `${who} moved **${card}** from ${a.data.listBefore.name} to ${a.data.listAfter.name}`
      }
      if (a.data?.old && 'closed' in a.data.old) {
        return `${who} ${a.data.card.closed ? 'archived' : 'restored'} **${card}**`
      }
      if (a.data?.old && 'due' in a.data.old) {
        const due = a.data.card?.due
        return `${who} ${due ? `set the due date on **${card}** to ${clock(due)}` : `cleared the due date on **${card}**`}`
      }
      if (a.data?.old && 'dueComplete' in a.data.old) {
        return `${who} marked **${card}** ${a.data.card.dueComplete ? 'complete' : 'not complete'}`
      }
      if (a.data?.old && 'name' in a.data.old) return `${who} renamed a card to **${card}**`
      if (a.data?.old && 'desc' in a.data.old) return `${who} edited the description on **${card}**`
      if (a.data?.old && 'idMembers' in a.data.old) return `${who} changed members on **${card}**`
      return `${who} updated **${card}**`
    }
    default:
      return `${who} did ${a.type}`
  }
}

export async function collectTrello ({ since, config }) {
  if (!process.env.TRELLO_KEY || !process.env.TRELLO_TOKEN) {
    return { title: 'Trello', configured: false, setupHint: 'Add TRELLO_KEY and TRELLO_TOKEN to .env.' }
  }

  const me = await get('/members/me', { fields: 'id,username,fullName' })
  const wanted = config.trello?.boards
  let boards = await get('/members/me/boards', { filter: 'open', fields: 'name,shortUrl,dateLastActivity' })
  if (Array.isArray(wanted)) boards = boards.filter(b => wanted.includes(b.name) || wanted.includes(b.id))
  const excluded = config.trello?.excludeBoards || []
  boards = boards.filter(b => !excluded.includes(b.name) && !excluded.includes(b.id))

  const sinceISO = since.toISOString()
  const dueWindow = Date.now() + (config.trello?.dueSoonDays ?? 3) * 86400e3
  const body = []
  const attention = []

  for (const board of boards) {
    const quiet = !board.dateLastActivity || new Date(board.dateLastActivity) < since
    const actions = quiet
      ? []
      : await get(`/boards/${board.id}/actions`, { since: sinceISO, limit: '200', filter: ACTION_FILTER })

    const cards = await get(`/boards/${board.id}/cards`, {
      filter: 'open',
      fields: 'name,due,dueComplete,idMembers,shortUrl'
    })
    // Overdue is deliberately not reported: the board carries year old due dates
    // that drown everything else. Only cards coming up are worth a line.
    const mine = cards.filter(c => c.idMembers?.includes(me.id))
    const dueSoon = mine.filter(c => c.due && !c.dueComplete && new Date(c.due) >= new Date() && new Date(c.due) <= dueWindow)

    if (!actions.length && !dueSoon.length) continue

    body.push(`### ${board.name}`)
    body.push('')

    if (actions.length) {
      const counts = new Map()
      for (const a of actions) counts.set(a.type, (counts.get(a.type) || 0) + 1)
      const summary = [...counts.entries()].map(([type, n]) => `${n} ${type}`).join(', ')
      const people = [...new Set(actions.map(a => a.memberCreator?.fullName).filter(Boolean))]
      body.push(`${actions.length} action${actions.length === 1 ? '' : 's'} by ${people.join(', ') || 'unknown'} (${summary}).`)
      body.push('')
      for (const a of actions.slice(0, 25)) {
        body.push(`- ${describe(a)} (${clock(a.date)})`)
      }
      if (actions.length > 25) body.push(`- plus ${actions.length - 25} more`)
      body.push('')
    } else {
      body.push('No card activity in this window.')
      body.push('')
    }

    // Mentions and fresh assignments are the real signal. Year old due dates are not.
    const mentions = actions.filter(a =>
      a.type === 'commentCard' && new RegExp(`@${me.username}\\b`, 'i').test(a.data?.text || ''))
    if (mentions.length) {
      body.push('**Comments that tag you**')
      for (const a of mentions) {
        const text = (a.data?.text || '').replace(/\s+/g, ' ').trim()
        body.push(`- **${a.data?.card?.name}**, ${a.memberCreator?.fullName || 'someone'} (${clock(a.date)}): "${text.length > 200 ? text.slice(0, 200) + '...' : text}"`)
      }
      body.push('')
      attention.push(`${mentions.length} comment${mentions.length === 1 ? '' : 's'} on ${board.name} tag you: ${[...new Set(mentions.map(a => a.data?.card?.name))].join(', ')}`)
    }

    const addedToMe = actions.filter(a => a.type === 'addMemberToCard' && a.data?.idMember === me.id)
    if (addedToMe.length) {
      attention.push(`You were put on ${addedToMe.length} card${addedToMe.length === 1 ? '' : 's'} on ${board.name}: ${addedToMe.map(a => a.data?.card?.name).join(', ')}`)
    }

    if (dueSoon.length) {
      body.push('**Your cards due soon**')
      for (const c of dueSoon) body.push(`- [${c.name}](${c.shortUrl}), due ${clock(c.due)}`)
      body.push('')
    }
  }

  if (!body.length) return { title: 'Trello', configured: true, body: [], attention }
  return { title: 'Trello', configured: true, body, attention }
}
