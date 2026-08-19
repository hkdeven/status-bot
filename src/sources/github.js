import { execFileSync } from 'node:child_process'
import { ago, clock } from '../render.js'

const QUERY = `
query($owner:String!, $name:String!, $since:GitTimestamp!) {
  repository(owner:$owner, name:$name) {
    nameWithOwner
    pushedAt
    defaultBranchRef { name }
    refs(refPrefix:"refs/heads/", first:100, orderBy:{field:ALPHABETICAL, direction:ASC}) {
      nodes {
        name
        target {
          ... on Commit {
            committedDate
            history(first:25, since:$since) {
              nodes { oid messageHeadline committedDate additions deletions author { name user { login } } }
            }
          }
        }
      }
    }
    pullRequests(states:[OPEN], first:25, orderBy:{field:UPDATED_AT, direction:DESC}) {
      nodes { number title updatedAt isDraft url author { login } }
    }
    issues(states:[OPEN], first:25, orderBy:{field:UPDATED_AT, direction:DESC}) {
      nodes { number title updatedAt url author { login } }
    }
  }
}`

function token () {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
}

async function graphql (auth, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables })
  })
  const json = await res.json()
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '))
  if (!json.data || !json.data.repository) throw new Error(`no data for ${variables.owner}/${variables.name}`)
  return json.data.repository
}

export async function collectGithub ({ since, config }) {
  const repos = config.github?.repos || []
  if (!repos.length) {
    return { title: 'GitHub', configured: false, setupHint: 'Add repos to config.json.' }
  }

  let auth
  try {
    auth = token()
  } catch {
    return { title: 'GitHub', configured: false, setupHint: 'Run `gh auth login` so the bot can read the repos.' }
  }

  const sinceISO = since.toISOString()
  const body = []
  const attention = []

  for (const full of repos) {
    const [owner, name] = full.split('/')
    let repo
    try {
      repo = await graphql(auth, { owner, name, since: sinceISO })
    } catch (err) {
      body.push(`### ${full}`, '', `Could not read: ${err.message}`, '')
      continue
    }

    const seen = new Set()
    const commits = []
    // Default branch first, so a shared commit is credited to main rather than a feature branch.
    const defaultName = repo.defaultBranchRef?.name
    const refs = [...repo.refs.nodes].sort((a, b) => (b.name === defaultName) - (a.name === defaultName))
    for (const ref of refs) {
      const history = ref.target?.history?.nodes || []
      for (const c of history) {
        if (seen.has(c.oid)) continue
        seen.add(c.oid)
        commits.push({ ...c, branch: ref.name })
      }
    }
    commits.sort((a, b) => new Date(b.committedDate) - new Date(a.committedDate))

    const prs = repo.pullRequests.nodes.filter(p => new Date(p.updatedAt) >= since)
    const issues = repo.issues.nodes.filter(i => new Date(i.updatedAt) >= since)

    body.push(`### ${full}`)
    body.push('')

    if (!commits.length && !prs.length && !issues.length) {
      const quiet = repo.pushedAt ? `quiet, last push ${ago(repo.pushedAt)}` : 'quiet'
      body.push(`No activity in this window (${quiet}).`)
      body.push('')
      continue
    }

    if (commits.length) {
      const byBranch = new Map()
      for (const c of commits) {
        if (!byBranch.has(c.branch)) byBranch.set(c.branch, [])
        byBranch.get(c.branch).push(c)
      }
      const authors = [...new Set(commits.map(c => c.author?.user?.login || c.author?.name).filter(Boolean))]
      body.push(`${commits.length} commit${commits.length === 1 ? '' : 's'} on ${byBranch.size} branch${byBranch.size === 1 ? '' : 'es'} by ${authors.join(', ') || 'unknown'}.`)
      body.push('')
      for (const [branch, list] of byBranch) {
        const churn = list.reduce((sum, c) => sum + (c.additions || 0) + (c.deletions || 0), 0)
        body.push(`**${branch}** (${list.length}, ~${churn} lines changed)`)
        for (const c of list.slice(0, 8)) {
          const who = c.author?.user?.login || c.author?.name || 'unknown'
          body.push(`- \`${c.oid.slice(0, 7)}\` ${c.messageHeadline} (${who}, ${clock(c.committedDate)})`)
        }
        if (list.length > 8) body.push(`- plus ${list.length - 8} more`)
        body.push('')
      }
    }

    if (prs.length) {
      body.push('**Open pull requests touched**')
      for (const p of prs) {
        body.push(`- [#${p.number}](${p.url}) ${p.title}${p.isDraft ? ' (draft)' : ''}, ${p.author?.login || 'unknown'}, ${ago(p.updatedAt)}`)
      }
      body.push('')
    }

    if (issues.length) {
      body.push('**Open issues touched**')
      for (const i of issues) {
        body.push(`- [#${i.number}](${i.url}) ${i.title}, ${i.author?.login || 'unknown'}, ${ago(i.updatedAt)}`)
      }
      body.push('')
    }

    const newBranches = [...new Set(commits.map(c => c.branch))].filter(b => !['main', 'master', 'develop', 'dev'].includes(b))
    if (newBranches.length >= 3) {
      attention.push(`${full} saw work on ${newBranches.length} non-default branches: ${newBranches.slice(0, 5).join(', ')}`)
    }
  }

  return { title: 'GitHub', configured: true, body, attention }
}
