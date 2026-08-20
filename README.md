# status-bot

A single daily digest of what moved across GitHub, Outlook, Trello and Zoho Projects.
Runs on this Mac, writes a markdown file, sends nothing anywhere.

## Running it

```bash
node src/index.js              # since the last scheduled digest
node src/index.js --since=24h  # ad hoc window: 24h, 3d, today, or a date
node src/index.js --only=github
node src/index.js --quiet      # print only the file path
```

Output goes to `digests/YYYY-MM-DD.md` and `digests/latest.md`, plus a styled
`.html` copy of each. macOS has no Markdown renderer, so the HTML is what you
actually read: it opens formatted in any browser, needs nothing installed, and
follows the system light or dark setting.

Only `--digest` style runs (`--write-state`, no `--since`) advance the window,
so an on demand run never swallows the next morning's news.

## Schedule

A launchd agent runs `run-digest.sh` at 07:00 Monday to Friday. Point a plist at
that script and load it, for example `~/Library/LaunchAgents/com.status-bot.plist`.

```bash
launchctl list | grep status-bot                                # is it registered
launchctl unload ~/Library/LaunchAgents/com.status-bot.plist    # stop it
launchctl load ~/Library/LaunchAgents/com.status-bot.plist      # start it
```

If the Mac is asleep at 07:00 the run happens at the next wake. Output lands in
`digests/latest.md`, errors in `digests/run.log` and `digests/launchd.err.log`.

## On demand

Three ways, no terminal needed:

- Ask Claude Code for the digest, or add a `/status` skill that shells out to
  `node src/index.js --quiet` and summarizes the result in chat.
- Put a `.command` launcher on the Desktop that runs the bot and opens the file.
- Symlink `digests/latest.html` to the Desktop to read the last digest without
  refreshing it.

## Sources

| Source | Status | Auth |
| --- | --- | --- |
| GitHub | ready | reuses the `gh` CLI token already on your machine |
| Outlook | ready | Entra app registration, delegated Mail.Read, device code sign in |
| Trello | needs setup | read only API key plus token in `.env` |
| Zoho Projects | needs setup | self client refresh token in `.env`, read scopes only |

Copy `config.example.json` to `config.json` and set your repos, mailbox
addresses, boards and projects there. `config.json` is gitignored, since the
things it names are usually private.
`zoho.excludeProjects` drops noisy template projects from the digest.
Zoho project names are cached in `.tokens/zoho-projects.json` so a portal with
hundreds of contracts costs one lookup, not hundreds.
Secrets live in `.env` and cached OAuth tokens in `.tokens/`. Both are gitignored.

## What each source reports

- **GitHub**: commits per branch with author and churn, open PRs and issues touched.
- **Trello**: card actions, comments, comments that tag you, cards you were added
  to, your overdue and due soon cards.
- **Zoho Projects**: portal wide activity grouped by sprint tag, task comments
  with mentions decoded, field changes on the fields in `zoho.watchFields`, and
  your open tasks. `zoho.sprintTagPattern` decides which tag counts as the
  sprint, default `SPRINT`. Sprint headings sort by the date in the tag name,
  so `21 AUGUST SPRINT` comes before `28 AUGUST SPRINT`, and anything without a
  sprint tag lands in one bucket at the end.
- **Outlook**: only mail that needs a reply or is worth knowing about. Help desk
  queues, incident notifications, Field Service digests, RFI mail, shipping
  notices and anything automated are dropped silently, with no list and no
  count. Rules live in `outlook.ignoreRules` and match on sender and subject
  only, never body text, because words like "shipping" and "field service" also
  appear in real mail from colleagues.
  Notification mail from Trello, Zoho and GitHub is dropped as a duplicate when
  that source already reported in the same digest, and counted in one line so
  you can see it happened. Two exceptions keep it visible: the source failed or
  is not connected, and GitHub mail about a repo missing from `config.json`,
  which is the only place that repo could surface. Turn the whole behaviour off
  with `outlook.suppressCoveredNotifications: false`.

Zoho never reports what a field changed to, only that it changed, so the bot
snapshots the watched fields on each scheduled run and diffs the next one.
Seed a baseline over a wider window without moving the digest window:

```bash
node src/index.js --since=14d --write-state --quiet
```

Zoho also throttles at 100 requests per endpoint per two minutes. Anything that
can be read per project is read per project, tag and comment lookups are capped,
and a throttled call adds a "Gaps in this digest" note rather than silently
dropping data.

## Tests

```bash
npm test
```

Covers the duplicate suppression rules, which cannot be exercised against a live
mailbox without signing in.

## Design notes

Everything is read only. Nothing in this project sends mail, comments on a card,
or writes to a repo, and it should stay that way.

Delivery is a local file by choice. If it ever needs to reach a phone, the CLI
is what an OpenClaw bot or a scheduled task would call, so no collector changes.
