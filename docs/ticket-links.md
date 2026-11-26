# Ticket links

*Spec, 2026-11-25, revised with the owner's answers. All three phases are built: trackers and encrypted settings, links, and writing back on Complete; see [Phases](#phases).*

A session's card shows the tickets it's working on, from Jira, Linear, GitHub Issues and Zendesk, as chips with each ticket's status that open it. Several systems can be connected at once. Completing a session can then comment on its tickets and move them to done, after asking.

## Why

The work a session does usually belongs to a ticket somewhere. Today a card can show the pull requests Claude Code opened, but not the ticket behind them. Linking them means:

- You can see which ticket each card is for, and its status, and open it in one click.
- A card for a ticket that's already done, or a session still open on a solved support ticket, stands out.
- Complete can close the loop: a comment with what the session did and its pull requests, and the ticket moved along, without switching to the tracker.

## Trackers

A tracker is one system at one address, signed in. There can be several, of the same type or different ones, such as two Jira sites, a Linear workspace and a Zendesk.

| Type | Address | Sign-in |
|---|---|---|
| **Jira** | The site, such as `https://example.atlassian.net` | Email and API token |
| **Linear** | None needed | Personal API key |
| **GitHub Issues** | None needed | `gh`'s own sign-in; no token is stored |
| **Zendesk** | The subdomain, such as `https://example.zendesk.com` | Email and API token, or an OAuth access token |

Each tracker can also list **key prefixes**, such as `ABC` and `OPS`. They're optional: with them, only keys with those prefixes are looked up there; without, any key is tried. The same prefix can be in more than one tracker.

A ticket is only linked if its tracker says it exists: no ticket, no connection. So every tracker needs its sign-in from the start, and every chip has the ticket's title and status.

## Settings and secrets

**Settings → Tickets** manages the trackers: add one, edit it, **Test** it, which signs in and says as whom ("Connected as *name*"), and remove it.

What's saved is encrypted in `~/.tabherd/settings.json`, as `enc:v1:…` values (AES-256-GCM):

- **Encrypted:** every tracker, with its address, email, prefixes and token. The keys Tabherd already keeps are encrypted too: LocalAI's API key and LM Studio's token. The plain settings, such as card size or the ComfyUI address, stay readable.
- **The encryption key** is 32 random bytes that the operating system keeps for the signed-in user:
  - **Windows:** protected with DPAPI for the current user, in `~/.tabherd/secret.key`. Only that Windows user, on that computer, can unlock it.
  - **macOS:** an item in the login Keychain, written through `security`, with the key passed on its input so it never shows in a process list.
  - **Linux:** the Secret Service (GNOME Keyring, KWallet) through `secret-tool`. Without one, as on a server or in WSL, it's kept in `~/.tabherd/secret.key`, readable only by you, and Settings says that file's permissions are all that protects it.
- **Moving computers:** a `settings.json` copied to another computer, or another user, can't be read there. Tabherd treats those settings as unset, and Settings asks for them again.
- **Existing plain values** are encrypted the first time the server starts with this version.
- **The page never gets a token:** a token shows as *Set*, with **Replace** and **Clear**. Trackers' addresses and emails, needed to edit them, come from a route that needs the page's per-run token, as session actions do.

## Where a session's tickets come from

1. **Its branch.** A key anywhere in the branch name, in any case, since Linear's own branch names are lower case (`eng-42-fix-login` → `ENG-42`). For GitHub, a branch whose last part starts with a number and a word, as GitHub names a branch made from an issue (`123-fix-login` → issue 123 of the session's repository), when the repository's `origin` is on GitHub.
2. **Links in its prompts.** Ticket links in what you typed: `/browse/ABC-123` on a Jira site, `linear.app/<workspace>/issue/ENG-42/…`, `github.com/<owner>/<repo>/issues/123`, and `/agent/tickets/1234` on a Zendesk subdomain.
3. **Claims.** A line starting with `Claim:`, in a prompt you send or a reply from the session:
   - `Claim: ABC-123`, or several: `Claim: ABC-123, ENG-42`
   - `Claim: Linear ENG-42`: a tracker's name or type first, when the key could be in more than one
   - `Claim: owner/repo#12`, `Claim: #12` (the session's repository), `Claim: Zendesk 4567`, or a link
   - `Unclaim: ABC-123` takes one off.

   Claims in replies mean a session that creates an issue, through `gh issue create` or a Jira or Linear tool, can claim it, so it's linked once it exists. Bare keys elsewhere in prompts and replies aren't picked up, since a passing mention ("like ABC-12 did") isn't the session's ticket.
4. **By hand.** A **+ Ticket** chip on the card takes a pasted link or key, as a claim does.
5. **From its to-do.** A to-do can have tickets, added the same way in its dialog. Starting it passes them to the session, as its group is passed on today.

Each one is looked up. One that doesn't exist isn't linked. A key without a tracker named is looked up in every tracker it could be in, and linked in each that has it. A chip can be taken off with its ✕, and stays off for that session.

## What shows

- **Card:** a row of chips under the folder, beside the pull request links: `ABC-123 · In progress`, with a dot in the status's colour. Hovering shows the title and assignee, and clicking opens the ticket. Then **+ Ticket**.
- **History:** the same chips on each closed session, as they were when it closed. History's filter finds sessions by ticket key.
- **To-do cards and dialog:** their chips, and a field to add one. (Not yet: pasting a ticket link as a new to-do's title fills in the title from the ticket and puts its description in the notes. See [Later](#later).)

Statuses fall into the dashboard's own groups:

| | To do | In progress | Done | Closed, not done |
|---|---|---|---|---|
| **Jira** (status category) | `new` | `indeterminate` | `done` | |
| **Linear** (state type) | `triage`, `backlog`, `unstarted` | `started` | `completed` | `canceled` |
| **GitHub** | | `open` | `closed`, reason `completed` | `closed`, reason `not_planned` |
| **Zendesk** | `new` | `open`, `pending`, `hold` | `solved`, `closed` | |

**Filters** can pick cards by these groups, or *No ticket* (built 2026-11-26). A card with several tickets goes by its least finished one, closed counting as finished, so it's done only once every ticket is done or closed. **Ticket done**, which picks done and closed, is one of the usual filters, and was added once to filters saved before it. A filter that picks tickets shows once there's a tracker.

## Reading a ticket

- **Jira:** `GET <site>/rest/api/3/issue/<key>?fields=summary,status,assignee`, with Basic authorization from the email and API token. A *scoped* API token is refused at the site's own address. It has to go through `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/…`, with the cloud ID read once from `<site>/_edge/tenant_info`. Tabherd tries the site first and falls back to that address if refused. **Test** reads `/rest/api/3/myself`.
- **Linear:** `POST https://api.linear.app/graphql` with the key as `Authorization: <key>`, no "Bearer". The query is `issue(id: "ENG-42") { identifier title url state { name type } assignee { name } }`. **Test** reads `viewer { name }`.
- **GitHub:** `gh api repos/<owner>/<repo>/issues/<n>`. A pull request number answers too, and is shown as a pull request. **Test** runs `gh api user`.
- **Zendesk:** `GET <subdomain>/api/v2/tickets/<id>.json`. With an API token, Basic authorization from `<email>/token:<token>`; with an OAuth access token, `Bearer`. Zendesk has deprecated API tokens in favour of OAuth, with removal reported for 2027-04-30, so both are taken. **Test** reads `/api/v2/users/me.json`.

Reads are cached for five minutes per ticket, and a ticket found not to exist for an hour. Only tickets on cards that are shown, or in History while it's open, are read, at most four at a time. A tracker that refuses its sign-in, or can't be reached, says so in Settings → Tickets; its tickets keep their last known status until it answers again.

## Writing back on Complete

For a session with tickets whose tracker can write, **Complete** opens a dialog in place of its second click. For each ticket:

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

- **Requests go only to configured trackers:** their addresses, `api.atlassian.com` for a scoped Jira token, `api.linear.app`, and GitHub through `gh`. A link found in a session is only read for its key. It's never fetched, so text in a session can't make the server call an address of its choosing.
- **What leaves the computer:** to read, a ticket's key or number, to the trackers that could hold it. To write, only the text and change shown in the dialog, after you click Complete. Nothing is written to a tracker without that.
- **Secrets:** encrypted at rest as above, never sent to the page, never written to logs or error messages. Settings → Tickets says what each sign-in needs:
  - **Jira:** read access, plus write to comment and move tickets. As token scopes, that's `read:jira-work` and `write:jira-work`.
  - **Linear:** a key with read, or read and write.
  - **Zendesk:** an agent's sign-in.
  - **GitHub:** `gh`'s, with `repo` scope for private repositories.
- **The server's routes for tickets** need the page's per-run token.

## Testing

- **Finding tickets:** unit tests for branch names in every form above, links, claims (several per line, a tracker named, `Unclaim:`), case, a key in two trackers, a `123-…` branch outside GitHub, and text that must not match (`UTF-8`, `v1-2`, a claim in the middle of a line).
- **Encryption:** a round trip; a value encrypted under another key reading as unset; plain values encrypted on first start. On Windows, DPAPI is also tested in CI, on the Windows runner.
- **Each tracker:** a stand-in server answering as its API's documentation says, as `test/apps.test.js` has for LocalAI. It covers reads, Test, a refused sign-in, a missing ticket, Jira's scoped-token fallback, and the writes, checking exactly what's sent.
- **The page:** headless Edge for Settings → Tickets, the chips, **+ Ticket**, History and the Complete dialog.
- **Real accounts:** the owner tries each tracker. Tokens are entered in Settings by the owner, never pasted into a chat or committed.

## Phases

Each is one pull request:

1. **Trackers and encrypted settings:** the encryption, with LocalAI's and LM Studio's keys moved into it, and Settings → Tickets with **Test**.
2. **Links:** finding, claiming and looking up tickets, **+ Ticket**, and chips with status on cards, to-dos and History, stored in `tickets.json`.
3. **Writing back:** the Complete dialog, comments and moving to done.

## Later

- **A to-do from a ticket:** pasting a ticket link as a new to-do's title fills in the title from the ticket and puts its description in the notes.
- **Create a ticket** from **+ Ticket**, in a tracker you choose, from the session's title and recap.
- Comment on a ticket from a card at any time, not only on Complete.
- Other trackers: Azure DevOps, GitLab issues, Shortcut, YouTrack, Freshdesk, ServiceNow. Each is a reader and a writer behind the same tracker interface.
- Zendesk OAuth sign-in from Settings, rather than pasting a token made in Zendesk's Admin Center.

## Owner's decisions

1. **Bare keys in prompts aren't picked up.** A `Claim:` line links a ticket explicitly, in prompts and replies, with a tracker named when several are connected.
2. **No existing ticket, no connection.** Every ticket is looked up before it's linked. A session can create the ticket, and claim it.
3. **The comment's wording** is as above for now.
4. **Zendesk comments are internal notes** unless *Public reply* is ticked.
5. **Secrets, sign-ins and addresses** are managed in Settings and encrypted in the JSON.

## To check first

- That Linear's `issue(id:)` takes an identifier such as `ENG-42`, through the schema's introspection.
- Jira's scoped-token fallback, against a real site.
- How a Zendesk account with API tokens turned off answers, so Settings can say to use OAuth.
- That `security` and `secret-tool` work from the desktop app's bundled Node as they do from a terminal.
