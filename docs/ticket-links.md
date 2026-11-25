# Ticket links

*Spec, 2026-11-25. Nothing is built yet; see [Phases](#phases).*

A session's card shows the tickets it's working on, from Jira, Linear, GitHub Issues and Zendesk, as chips that open them. With a token for a system, each chip also shows the ticket's title and status. Completing a session can then comment on its tickets and move them to done, after asking.

## Why

The work a session does usually belongs to a ticket somewhere. Today a card can show the pull requests Claude Code opened, but not the ticket behind them. Tickets do turn up in sessions: branch names like `feature/ABC-123-retry-uploads` or `eng-42-fix-login`, and ticket links pasted into prompts. Linking them means:

- You can see which ticket each card is for, and open it in one click.
- With status, a card for a ticket that's already done, or a session still open on a closed support ticket, stands out.
- Complete can close the loop: a comment with what the session did and its pull requests, and the ticket moved along, without switching to the tracker.

## Trackers

**Settings → Tickets** lists the trackers: each is one system at one address. There can be several of a type, such as two Jira sites.

| Type | Address | Keys | Token (stage 2 on) |
|---|---|---|---|
| **Jira** | The site, such as `https://example.atlassian.net` | Project keys, such as `ABC`, `OPS` | Email and API token |
| **Linear** | None needed | Team keys, such as `ENG` | Personal API key |
| **GitHub Issues** | None needed | None: references name the repository | None: uses `gh`'s sign-in |
| **Zendesk** | The subdomain, such as `https://example.zendesk.com` | Optional, such as `ZD` for `ZD-1234` in branch names | Email and API token, or an OAuth access token |

Jira and Linear keys look the same (`ABC-123`), so a key belongs to whichever tracker lists its prefix. A prefix can be in only one tracker. A pasted link names its own system and address, so it needs no prefix, only a tracker at that address (or, for Linear and GitHub, a tracker of that type).

Settings are kept in `~/.tabherd/settings.json` with the rest. Tokens are stored there too and never sent to the page, as LocalAI's key isn't: the page only learns whether one is set.

## Stage 1: links

### Where a session's tickets come from

1. **Its branch.** A key with a known prefix anywhere in the branch name, in any case, since Linear's own branch names are lower case (`eng-42-fix-login` → `ENG-42`). For GitHub, a branch whose last part starts with a number and a word, as GitHub names a branch made from an issue (`123-fix-login` → issue 123 of the session's repository), when the repository's `origin` is on GitHub.
2. **Links in its prompts.** Ticket links in what you typed, not in Claude's replies: `/browse/ABC-123` on a Jira site, `linear.app/<workspace>/issue/ENG-42/…`, `github.com/<owner>/<repo>/issues/123`, and `/agent/tickets/1234` on a Zendesk subdomain. Bare keys in prompts aren't picked up, since a passing mention ("like ABC-12 did") isn't the session's ticket.
3. **By hand.** A **+ Ticket** chip on the card takes a pasted link or key: `ABC-123`, `owner/repo#123`, `#123` (in the session's repository) or a link. It's accepted only if a tracker matches.
4. **From its to-do.** A to-do can have tickets, added the same way in its dialog. Starting it passes them to the session, as its group is passed on today.

A chip found automatically can be taken off with its ✕, and stays off for that session. Several tickets per session are fine.

### What shows

- **Card:** a row of chips under the folder, beside the pull request links: `ABC-123`, `owner/repo#123`, `Zendesk #1234`. Each opens the ticket in the browser. Then **+ Ticket**.
- **History:** the same chips on each closed session, and History's filter finds sessions by ticket key.
- **To-do cards and dialog:** their chips, and a field to add one.

### Storage

`~/.tabherd/tickets.json`, by session ID: tickets added by hand and found ones taken off. Found ones aren't stored; they're worked out again from the branch and prompts. A closed session's History entry keeps the tickets it had, as it keeps its to-do. To-dos keep theirs in `todos.json`.

## Stage 2: title and status

With a tracker's token set, each chip also shows the ticket's status as a coloured dot, `ABC-123 · In progress`. Hovering shows the title and assignee. Statuses fall into the dashboard's own groups:

| | To do | In progress | Done | Closed, not done |
|---|---|---|---|---|
| **Jira** (status category) | `new` | `indeterminate` | `done` | |
| **Linear** (state type) | `triage`, `backlog`, `unstarted` | `started` | `completed` | `canceled` |
| **GitHub** | | `open` | `closed`, reason `completed` | `closed`, reason `not_planned` |
| **Zendesk** | `new` | `open`, `pending`, `hold` | `solved`, `closed` | |

How each is read, one ticket at a time:

- **Jira:** `GET <site>/rest/api/3/issue/<key>?fields=summary,status,assignee`, with Basic authorization from the email and API token. A *scoped* API token is refused at the site's own address; it has to go through `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…`, with the cloud ID read once from `<site>/_edge/tenant_info`. Tabherd tries the site first and falls back to that address if refused.
- **Linear:** `POST https://api.linear.app/graphql` with the key as `Authorization: <key>`, no "Bearer". The query is `issue(id: "ENG-42") { identifier title url state { name type } assignee { name } }`.
- **GitHub:** `gh api repos/<owner>/<repo>/issues/<n>`, so no token is stored. A pull request number answers too; it's shown as a pull request.
- **Zendesk:** `GET <subdomain>/api/v2/tickets/<id>.json`. With an API token, Basic authorization from `<email>/token:<token>`; with an OAuth access token, `Bearer`. Zendesk has deprecated API tokens in favour of OAuth, with removal reported for 2027-04-30, so both are taken.

Reads are cached for five minutes per ticket. Only tickets on cards that are shown, or in History while it's open, are read, at most four at a time. A tracker that refuses its token, or can't be reached, says so once in Settings → Tickets, and its chips stay plain links. A ticket that doesn't exist loses its chip if it was found automatically, so a branch named `123-…` with no issue 123 shows nothing.

**New to-do from a ticket:** pasting a ticket link into a new to-do's title fills in the title from the ticket and adds the description to the notes.

## Stage 3: writing back on Complete

For a session with tickets whose tracker has a token that can write, **Complete** opens a dialog in place of its second click. For each ticket:

- **Comment**, unticked at first, with the text to post, which you can edit:
  > Done in a Claude Code session (*session name*): *its recap, or its last reply*.
  >
  > Pull requests: *its pull request links*.
- **Move to done**, unticked at first:
  - **Jira:** the transitions into a status in the *done* category, read from `GET …/issue/<key>/transitions`. One is chosen for you if there's only one; otherwise you pick. Sent with `POST …/issue/<key>/transitions`.
  - **Linear:** the team's first state of type `completed`, set with `issueUpdate`.
  - **GitHub:** close as completed (`state=closed`, `state_reason=completed`).
  - **Zendesk:** set to *Solved*. This emails the requester, and the dialog says so.
- **Zendesk comments** are internal notes (`"public": false`) unless *Public reply* is ticked, since a public reply emails the customer.

Your ticks are remembered for each tracker, and the dialog still opens every time. **Complete** posts each ticked change, then closes the session. If one fails, the dialog stays open with the error, and **Complete anyway** closes the session without it. A session with no tickets, or none it can write to, keeps the two-click Complete.

How each writes:

- **Jira:** `POST …/issue/<key>/comment`, the text in Atlassian Document Format, with links as links.
- **Linear:** `commentCreate(input: { issueId, body })`, in Markdown.
- **GitHub:** `gh api -X POST repos/<owner>/<repo>/issues/<n>/comments -f body=…`.
- **Zendesk:** `PUT …/tickets/<id>.json` with `{ "ticket": { "comment": { "body": …, "public": false } } }`, plus `"status": "solved"` if ticked.

## Security and privacy

- **Requests go only to configured trackers:** their addresses, `api.atlassian.com` for a scoped Jira token, `api.linear.app`, and GitHub through `gh`. A link found in a prompt is only read for its key. It is never fetched, so text in a session can't make the server call an address of its choosing.
- **What leaves the computer:** in stage 2, a ticket's key or number, to the tracker that holds it. In stage 3, only the text and change shown in the dialog, after you click Complete. Nothing is written to a tracker without that.
- **Tokens:** kept in `~/.tabherd/settings.json`, never sent to the page or written to logs. Settings → Tickets says what each token needs. Jira: read access for stage 2, plus write for stage 3 (as scopes, `read:jira-work` and `write:jira-work`). Linear: a key with read, or read and write. Zendesk: an agent's. GitHub: `gh`'s own sign-in, with `repo` scope for private repositories.
- **API protection:** the server's routes for tickets need the page's token, as the session actions do.

## Testing

- Unit tests for finding tickets: branch names in every form above, links, case, prefixes in two trackers, a `123-…` branch outside GitHub, and keys that must not match (`UTF-8`, `v1-2`).
- A stand-in server for each tracker, as `test/apps.test.js` has for LocalAI, answering as each API's documentation says: reads, a refused token, a missing ticket, Jira's scoped-token fallback, and the stage 3 writes with exactly what's sent.
- Headless Edge for the chips, **+ Ticket**, History and the Complete dialog.
- The owner tries each tracker with a real account. Tokens are set in Settings by the owner, never pasted into a chat or committed.

## Phases

Each is one pull request:

1. **Links:** trackers in Settings without tokens, finding tickets, **+ Ticket**, chips on cards, to-dos and History, and `tickets.json`.
2. **Status:** tokens, reading each system, the status dots, a to-do from a ticket link.
3. **Writing back:** the Complete dialog, comments and moving to done.

## Later

- Comment on a ticket from a card at any time, not only on Complete.
- A filter tab by ticket status, such as "Ticket done, session still open".
- Other trackers: Azure DevOps, GitLab issues, Shortcut, YouTrack, Freshdesk, ServiceNow. Each is a reader and a writer behind the same tracker interface.
- Zendesk OAuth sign-in from Settings, rather than pasting a token made in Zendesk's Admin Center.

## Decisions for the owner

1. **Bare keys in prompts:** left out, so only branches, links and hand-added tickets count. Picking up `ABC-123` typed in a prompt would catch more tickets, and more passing mentions.
2. **GitHub branch numbers:** `123-fix-login` counts as issue 123 only once stage 2 confirms the issue exists, or straight away in stage 1?
3. **The comment's wording**, above.
4. **Zendesk:** internal notes by default, with *Public reply* to opt in.

## To check first

- That Linear's `issue(id:)` takes an identifier such as `ENG-42`, through the schema's introspection.
- Jira's scoped-token fallback, against a real site.
- How a Zendesk account with API tokens turned off answers, so Settings can say to use OAuth.
