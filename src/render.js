const pad = n => String(n).padStart(2, '0')

export function stamp (date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function clock (iso) {
  const d = new Date(iso)
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ago (iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

export function render ({ since, generatedAt, sections }) {
  const lines = []
  lines.push(`# Status digest, ${stamp(generatedAt)}`)
  lines.push('')
  lines.push(`Covering activity since ${clock(since.toISOString())}. Generated ${clock(generatedAt.toISOString())}.`)
  lines.push('')

  const attention = sections.flatMap(s => (s.attention || []).map(a => `- **${s.title}:** ${a}`))
  if (attention.length) {
    lines.push('## Needs you')
    lines.push('')
    lines.push(...attention)
    lines.push('')
  }

  for (const section of sections) {
    lines.push(`## ${section.title}`)
    lines.push('')
    if (section.error) {
      lines.push(`Could not read this source: ${section.error}`)
      lines.push('')
      continue
    }
    if (!section.configured) {
      lines.push(`Not connected yet. ${section.setupHint || ''}`.trim())
      lines.push('')
      continue
    }
    if (!section.body || !section.body.length) {
      lines.push('Nothing new in this window.')
      lines.push('')
      continue
    }
    lines.push(...section.body)
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}
