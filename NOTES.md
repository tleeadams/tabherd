# Working notes

Where the project stands, what's unconfirmed, and what could come next. The README covers what each feature does.

## Status (2026-11-13)

Built and in use: the live session cards, Go to window, Catch up, terminal-tab titles, the ☰ repo menu, dings, and the desktop launcher.

Confirmed working on Windows 11, with Windows Terminal:
- Session detection, transcript parsing, subagents, and Stop (tested on a dummy process).
- Go to window for a session that's already the selected tab. Catch up end to end, on a real session.
- Terminal titles, including renamed tabs once they've been viewed.
- The launcher: it starts the server hidden, opens an Edge app window, and reuses it if it's already open.
- Dings, in headless Edge: the right sound for each change, muting, and the click-to-enable state.
- kitty and WezTerm on macOS (2026-11-20), on the owner's Mac with `npm run check-terminals`; kitty once a typo in kitty.conf was fixed. The runner's virtual machine has no OpenGL, so neither can open a window in the macOS workflow.
- Homebrew (2026-11-20): `brew install tleeadams/tap/tabherd` on the owner's Mac, from the prebuilt bottle, so without Apple's developer tools. The tap's workflows check installing from the bottle on macOS and Linux.
- The macOS drivers (2026-11-20), on a GitHub macOS runner (`.github/workflows/macos-terminals.yml`): Terminal, iTerm2, Ghostty 1.4 and tmux inside Terminal open a tab (a window for Terminal), go to the exact tab, read its title, take Catch up and stop. The owner's Mac first showed Terminal's and iTerm2's lookups failing ("Can't make item 1 of id of every window into type specifier"), and a kitty window opened from Terminal being driven as Terminal; both are fixed. On the runner, macOS's Automation permission is granted to the runner's agent, which macOS holds responsible for the job's processes.
- The Linux drivers (2026-11-20), on Ubuntu 24.04 in WSL with its desktop, through `npm run check-terminals` and a stand-in session: tmux (alone and inside kitty), kitty, WezTerm, GNOME Terminal and Konsole 23.08 open Claude's tab, go to the exact tab, take Catch up as a paste followed by Enter, and stop. GNOME Terminal can't be typed into from outside, and Konsole doesn't expose a program's title, as expected. WSL's desktop doesn't let apps bring windows forward, so raising windows wasn't checked.
- Driven through the real server's API (2026-11-19): opening a repo from the ☰ menu (a Claude tab opened); the folder picker, which opened in front of the other windows; a to-do's Start. Claude registered the `--session-id` it was given, and the to-do moved to the session's card within 2 seconds, including on the first Start after a fresh server start. Also Stop, after which the to-do left with the session and History recorded it with the to-do. Resume opened a tab running `claude --resume` in the right folder. That test session had never been asked anything, so Claude had no conversation to resume. That's why History now leaves such sessions out, and their to-dos come back.

Not yet confirmed in real use:
- Go to window for a renamed tab that isn't selected, which steps through the tabs. It worked in a dry run only.
- Resume carrying on a real conversation, and bringing a to-do back onto the resumed session's card. The unit tests cover the to-do part.
- Hearing an actual ding. The tests recorded the tones; no audio was played.
- The theme setting, Todo filter and notification list (2026-11-19). Tested in headless Edge, where the list's clearing rules were run against simulated status changes. A real agent's change hasn't been seen to add or clear an entry yet.
- Linux: Ghostty and Ptyxis, which Ubuntu 24.04 doesn't package. KDE's KWin script for bringing a window forward on Wayland, since the test machine has no KWin.
- Releases (2026-11-19). v0.1.1 was the Release workflow's first run. Its draft was checked before publishing: the zip matched its checksum and the tag file by file, its bundled server answered on every endpoint, and its launcher, built on GitHub, started a server. CI passes on Windows, macOS and Linux with Node 18 and 24. Downloaded through a browser, the zip got no download warning, but the launcher got SmartScreen's warning when run, as the README describes.

## Public (2026-11-19)

The repository is public, and v0.4.0 is the latest release. It's licensed GPL-3.0-or-later, and *Skip permission prompts* is off unless chosen.

Renamed from Claude Agents to Tabherd (2026-11-20). Anthropic's Claude Code terms don't allow its names in a product's name, and "Claude Agents" is close to "Claude Agent", Anthropic's own wording for products built on its Agent SDK. Searching for "claude agents" also brings up Anthropic's own docs first. "Tabherd" had no web results, and nothing on npm or GitHub of note. The description says what it works with: "a dashboard for your Claude Code sessions". The rename came before applying to SignPath, since the product name on a signed file must match the project.

No identifying information goes in the code, docs or history, including real work examples: use made-up names such as `work/acme/api`. The first commit was rewritten to match. Commits made locally are by "Lee" with the GitHub no-reply address. Merges made on GitHub's website use the account's profile name, with the same no-reply address.

GitHub Actions didn't run at first: no workflows were registered until the owner enabled Actions for the account. So v0.1.0 was built locally from the tag, the same way the Release workflow would, and published by hand.

All four rulesets are active, applied by `npm run setup-github`, and were tried on GitHub:
- Merging without a review was refused. So was updating `develop` directly, even through the API as the admin.
- A pull request from a branch named outside the model failed the Gitflow check. Its admin merge was refused, so the bypass doesn't cover "Gitflow".
- `gh pr merge --merge --admin` merged a pull request whose CI and Gitflow checks had passed, bypassing the review. GitHub logged it as a bypass.
- Deleting the `v0.1.0` tag was refused.

GitHub attaches check results to commits, not pull requests. A failed Gitflow check from one pull request blocks every other pull request on the same commit, even after it's closed and the other one's check passes again. CONTRIBUTING.md says how to clear it.

Also applied: `develop` as the default branch, merge commits only, merged branches deleted, and private vulnerability reporting. Reviews come from `.github/CODEOWNERS`, which names only the owner's GitHub handle so far. That handle is also in the repository's URL.

Still to do:
- Code-signing the launcher, through SignPath Foundation, which signs open-source projects for free as the publisher, so no personal name goes on the certificate. The Release workflow, the policy in the README and `.signpath/artifact-configuration.xml` are ready (2026-11-20). The signing steps haven't run yet: they need the project approved, then set up as in CONTRIBUTING.md. Signing won't stop the SmartScreen warning at once: since 2024 every signed file starts without reputation, EV certificates included, and earns it through downloads.
- macOS and Linux releases: a download with Node included and a `tabherd` command, then Homebrew and winget.

## Known limits

- Catch up adds its question to anything half-typed in that session's prompt box and sends both.
- Once in testing (2026-11-19), Windows Terminal opened no tab for a to-do's Start, though `wt.exe` reported success. It didn't happen again in six more tries, from the server or a script, so the cause is unknown. A to-do in that state says "No session yet" after a minute and offers Start again. For the repo menu or Resume, click again.
- A renamed tab is matched to its session only after it's been the selected tab, or by elimination.
- After each page load the browser blocks sound until you click the page. Allowing media autoplay for `http://localhost:4317` in Edge should remove that step; untested.
- The window and terminal features are Windows-only.
- The session registry (`~/.claude/sessions/*.json`) and transcript formats are Claude Code internals, read as of v2.1.304. A Claude Code update could change them.

## Planned (2026-11-19)

In build order, smallest first. Items 1 to 3 only change the page. Items 4 to 6 need settings or data the server keeps in a file between runs, so the first of those builds that store.

1. **Light / Dark / System theme** in Settings. *Built 2026-11-19.*
2. **A "Todo" filter** in the header: Needs you and Idle together. *Shell running* isn't included, for now. *Built 2026-11-19.*
3. **Notification list** opened from a header button, with a setting to keep it across reloads. An entry clears itself once its agent is working again. *Built 2026-11-19.*
4. **Excluded folders** in Settings, hiding a folder or repo and everything under it from the ☰ repo menu. The session cards are unaffected. *Built 2026-11-19*, along with the server's settings store (`lib/store.js`, `lib/settings.js`). Reworked the same day from a typed path to a nested tree of tick boxes. The server now scans everything once and hides the excluded folders afterwards, so Settings can show them and changing one doesn't rescan the disk.
5. **History of closed agents**, with Resume, filled in from the last 30 days of transcripts. *Built 2026-11-19* (`lib/history.js`).
6. **To-do cards.** A card with a title and notes but no folder or agent yet. You pick a working folder, and Start opens a Claude tab there. The card then becomes that session's card: starting Claude with `--session-id <uuid>` tells the server which session it turned into. *Built 2026-11-19* (`lib/todos.js`, `lib/pick-folder.ps1`).
   - A setting chooses where the folder comes from: the ☰ repo tree, or any folder through a Windows folder picker that the server opens. Another sets the default folder the choice starts from.
   - Start doesn't send the to-do's text to Claude. To use it as a prompt, copy and paste it into the session.
   - To-do cards count under All and the Todo filter.
   - Once linked, a to-do follows its session's process too, so it stays linked if the session ID changes (as `/clear` does). When the session closes, the to-do is hidden and kept for 30 days, so resuming the session brings it back. Its title and notes are also saved in the session's History entry.

## Ideas

- Windows desktop notifications alongside the dings, naming the agent.
- More settings in the Settings dialog: which Terminal window new tabs open in, and the port. Those belong on the server, not in browser storage.
- Keep learned tab names across server restarts.
- Totals across agents: running cost or tokens today, how many are waiting on you.
- A text filter for the cards.

## Development notes

- **After a server-side change**, stop the running `server.js` and start it through the Desktop shortcut. Then press Ctrl+R in the dashboard. Static files are re-read on each request, so a page-only change just needs Ctrl+R.
- **Testing beside the real server:** run a second one with `PORT=4399` and `TABHERD_DATA_DIR` set to a scratch folder, so tests don't change the real `~/.tabherd`.
- **Server settings:** each key in `lib/settings.js` has a check that cleans the value or rejects it. `POST /api/settings` changes only the keys sent, all or none. A hand-edited `settings.json` is checked the same way when the server starts.
- **Windows Terminal:** `profiles.defaults` sets `"elevate": true`. A tab opened with a command line but no profile gets that default and opens in a separate administrator instance, which also mangles the command. Always pass `-p <default profile>`. Tools can't see into or message administrator windows.
- **Windows started hidden:** Node's `windowsHide` tells Windows to hide the first window the child process shows. For the folder picker that was its owner window, and the dialog then returned OK at once, with the start folder, never having shown. `pick-folder.ps1` shows the owner a second time to get around that. Any other script the server runs that shows a window needs the same.
- **pwsh is the Microsoft Store build:** `pwsh.exe` is an app execution alias, which `fs.existsSync` reports as missing. Check for it with `fs.lstatSync`.
- **Screenshots:** headless Edge's `--screenshot` with `--virtual-time-budget` never finishes on this page, because the update stream keeps a request open. Drive Edge over the DevTools protocol instead (`--remote-debugging-port`, then `Page.captureScreenshot`). That also allows test-only scripts, such as recording the tones the page plays.
