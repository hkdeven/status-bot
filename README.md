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

Output goes to `digests/YYYY-MM-DD.md` and `digests/latest.md`.

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
- Symlink `digests/latest.md` to the Desktop to read the last digest without
  refreshing it.

## Sources

| Source | Status | Auth |
| --- | --- | --- |
| GitHub | ready | reuses the `gh` CLI token already on your machine |
| Outlook | needs setup | Entra app registration, delegated Mail.Read, device code sign in |
| Trello | needs setup | read only API key plus token in `.env` |
| Zoho Projects | needs setup | self client refresh token in `.env`, read scopes only |

Copy `config.example.json` to `config.json` and set your repos, mailbox
addresses, boards and projects there. `config.json` is gitignored, since the
things it names are usually private.
`zoho.excludeProjects` drops noisy template projects from the digest.
Zoho project names are cached in `.tokens/zoho-projects.json` so a portal with
hundreds of contracts costs one lookup, not hundreds.
Secrets live in `.env` and cached OAuth tokens in `.tokens/`. Both are gitignored.

## Design notes

Everything is read only. Nothing in this project sends mail, comments on a card,
or writes to a repo, and it should stay that way.

Delivery is a local file by choice. If it ever needs to reach a phone, the CLI
is what an OpenClaw bot or a scheduled task would call, so no collector changes.
