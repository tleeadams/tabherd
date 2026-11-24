# Changelog

Notable changes in each release. Version numbers follow [Semantic Versioning](https://semver.org). The release build takes each release's notes from its section here.

## Unreleased

- GitHub Copilot's sessions, from the Copilot CLI and from VS Code's agent, get cards marked **Copilot**: status, with *Needs you* while an approval is unanswered, the last prompt and reply, tools, model and tokens. CLI sessions have Go to window, Catch up and Stop, can be started from to-dos and the repo menu with their own ID and name, and are in History with Resume. See [GitHub Copilot](README.md#github-copilot).
- Ollama's and LM Studio's loaded models get cards, with their size, context and Unload, and Ollama's with the graphics memory each holds and when it will unload. Their addresses, and an LM Studio token, are in Settings → Other apps.

- **Save and close all**, in a new menu in the header, saves every open Claude and Codex session and closes it, tab and all, after asking. Sessions still working can be waited for, closing as each finishes its turn, or closed at once. **Resume last session** opens them all again, each carrying on its conversation. On Windows the tab closes because `exit` is typed into its shell once the session has ended, so Windows Terminal closes it as usual. See [Save and close](README.md#save-and-close).

- ComfyUI's jobs and LocalAI's models, downloads, agent chats and agent jobs show as cards, marked **Comfy** and **LocalAI**, and join the app list in the header. A ComfyUI job shows as Working, with its progress on Windows, Queued with its place, or Finished with its output image, and has Stop or Cancel and Go to window. A LocalAI model shows the memory it's using and has Unload; downloads show their progress and have Cancel; agent chats show as Working, or Needs you when paused, and have Stop. Finishing dings. Settings → Other apps has ComfyUI's and LocalAI's addresses, and LocalAI's API key; Comfy Desktop's ComfyUIs are found by themselves, on whatever port. See [ComfyUI and LocalAI](README.md#comfyui-and-localai).
- On Windows, the title-reading helper also reads the main window title of apps without a console, which is how Comfy Desktop's progress is read.

## 0.4.0 - 2026-11-23

- Codex sessions show on the dashboard beside Claude's, and each card says which app it is. A Codex card has its status, with *Needs you* when it's waiting for an approval or an answer, what it's doing, its last reply, model and tokens, and Go to window. Closed Codex sessions are in History, where Resume runs `codex resume`. See [Codex](README.md#codex).
- Codex sessions can be started and driven like Claude's. Settings → New sessions chooses Claude or Codex for the repo menu and to-dos, the repo menu has the same choice, and a to-do can name its own. A Codex to-do's session is linked to it once it starts, and named after it. **Catch up** sends the question through Codex's service with `codex queue`, so nothing is typed into the window. **Stop** interrupts the session's turn, then ends the Codex in its window. A Codex session's subagents are listed on its card. *Skip permission prompts* runs Codex with `--dangerously-bypass-approvals-and-sandbox`.
- A Codex card goes as soon as its window closes, when the dashboard knows the window, or else when Codex unloads the session, about a minute later.
- Groups, each with a name and one of eight colours, gather sessions by folder: a session or to-do is in the group with the nearest folder that holds it. The group button on a card moves it to another group, or none, by hand, and **New group for** makes a group for its folder. A group shows as a coloured line along the top of its cards and its name on the button, in History, and as a dot on its folders in the repo menu. Make and change groups in Settings → Groups, where *Sections by group* puts each group's cards under its name. See [Groups](README.md#groups).
- The header has a list for showing one app's sessions, Claude or Codex, once a Codex session is running, and one for showing one group, once there are groups. The counts on the status filters follow them.
- Background runs, with `claude -p`, such as a background PR review or a scheduled job, are marked **Background**, without Go to window or Catch up, which they have no window for. When one finishes, the dashboard dings and adds *Finished in the background* to the notifications, where its name resumes it in a terminal. History lists them, tagged, with a switch to hide them. Claude registers them like sessions in a terminal, so before this they looked like ones, with buttons that couldn't work, and ended without a ding. See [Background runs](README.md#background-runs).
- A session's registry file caught while Claude rewrites it keeps its last reading, so the session no longer drops off the dashboard for a moment.
- `server.js --once` exits once it has listed the sessions, instead of waiting on the dashboard's helper processes.
- On Linux, Claude Code running on Node 24 is recognised. Node 24 gives its process the name MainThread, so those sessions were left off the dashboard.
- Tabs the dashboard opens no longer take on the variables of a Codex session the dashboard was started from, which turn off colour and give them that session's IDs.

## 0.3.2 - 2026-11-22

- A to-do can start without a folder: it starts in Settings → To-dos → *Start in*, your repos folder unless you set another, where Claude can make a new project. **Choose folder** is there for picking one first. The card says where it will start.
- On macOS and Linux, the dashboard shows Go to window, Catch up, a to-do's Start and Choose folder, and History's Resume. They were still shown on Windows only, although the terminal drivers had been added.
- A session started from a to-do is named after it, with Claude's `--name`, so its tab's title and Claude's session list show the to-do's title.
- Sessions the dashboard opens no longer take on the variables of a Claude Code session the dashboard was started from. They ran as that session's children: plain, unattended, unseen by the dashboard, and holding its messaging pipe and token.

## 0.3.1 - 2026-11-21

- Tabherd can be installed with Homebrew on macOS and Linux: `brew install tleeadams/tap/tabherd`.
- A new logo, for the page, its tab, the Windows launcher, the macOS app and the Linux menu entry. `npm run icons` makes every size from `assets/logo.png`.
- The dashboard's buttons, links and highlights are the logo's blue, and *Shell running* is purple so it doesn't look like them. In dark mode, text on blue buttons is the logo's navy, which reads better than white did.

## 0.3.0 - 2026-11-20

- **macOS and Linux** can go to a session's window, catch it up, show its tab's title, and open Claude from the repo menu, Resume and to-dos, as Windows can. Supported: Terminal, iTerm2 and Ghostty on macOS; GNOME Terminal, Ptyxis and Konsole on Linux; kitty, WezTerm and tmux on both. What each terminal can do is in the README.
- Settings › New sessions › **Terminal** chooses the terminal Claude opens in, where there's more than one.
- **Stop** on macOS and Linux ends the session's child processes too, as on Windows.
- `npm start` opens a dashboard that's already running instead of failing, and opens it as an app window where Chrome, Edge, Brave, Chromium or Vivaldi is installed.
- `npm run check-terminals` checks each terminal on the computer with a stand-in session, not Claude.
- `Tabherd.exe` works when it's started through a link, as winget starts portable apps: it follows the link to its own folder.
- The folder in each download no longer has the version in its name (`tabherd-windows-x64`, not `tabherd-v0.2.0-windows-x64`), so updating replaces the same folder and shortcuts to it keep working. Shortcuts made for 0.2.0 or earlier point at the old folder: run **Install shortcuts.cmd** again after updating.
- **Downloads for macOS** (Apple silicon and Intel) **and Linux** (x64 and arm64), with Node included. `tabherd` opens the dashboard; `tabherd --install` adds Tabherd to Applications on macOS or the applications menu on Linux, and a `tabherd` command. `npm run install-shortcut` does the same from the source.
- Each release page starts by saying what Tabherd does, as SignPath Foundation asks of download pages.

## 0.2.0 - 2026-11-20

To update from Claude Agents 0.1.x: close its dashboard window, put this release's folder in place of the old one, run **Tabherd.exe**, then run **Install shortcuts.cmd** if you use shortcuts. The old version's server stops by itself within 10 minutes of its window closing; until then, Tabherd.exe opens the old page.

- Claude Agents is now **Tabherd**. The launcher is `Tabherd.exe` and the release zip `tabherd-v<version>-windows-x64.zip`. Settings, history and to-dos move from `~/.claude-agents` to `~/.tabherd` the first time the new version starts, and the settings this browser saved carry over. **Install shortcuts.cmd** replaces the old "Claude Agents" shortcuts, and **Remove shortcuts.cmd** removes either. `TABHERD_DATA_DIR` replaces `AGENTS_DATA_DIR`.
- The launcher's file details show its product name and version.
- Releases are ready to be signed through SignPath Foundation, once the project is approved. The README has the code signing policy, and how to uninstall.

## 0.1.2 - 2026-11-20

- History no longer lists sessions closed before Claude was asked anything. Claude saves no conversation for them, so Resume opened a tab that closed straight away.
- A to-do whose session closes unused comes back to its own card, ready to start again, rather than disappearing with its notes.
- A dashboard page left open while the server restarted can change things again. It kept sending the old run's token, so every change was refused: a setting such as *Skip permission prompts* switched straight back.
- Messages show on top of an open dialog, such as Settings, rather than hidden behind it.

## 0.1.1 - 2026-11-19

The first release built by the release workflow on GitHub rather than by hand. The dashboard itself is the same as in 0.1.0.

- CI can be run by hand, from the Actions tab or with `gh workflow run CI --ref <branch>`.
- CONTRIBUTING.md explains how to clear a failed check left on a commit by another pull request.

## 0.1.0 - 2026-11-19

The first public release. The dashboard runs anywhere Node 18 or later does. The window and terminal features, the desktop launcher and the release download are Windows-only for now.

- A live card for every Claude Code session on the computer: its status (Needs you, Working, Shell running, Idle), the tools running now, the latest reply or recap, the last prompt, the model, context use, subagents and PR links.
- Filters for each status, and Todo for everything waiting on you.
- Go to window, which finds the session's Windows Terminal tab, even a renamed one. Catch up, which asks the session where things stand.
- Sounds and a pop-up when a session needs you or finishes, and a list of those notifications that clears itself.
- A ☰ menu of the git repos under `~/source`, opening Claude in a new Windows Terminal tab. Settings can hide folders from it.
- History of closed sessions, filled in from the last 30 days of transcripts, with Resume.
- To-dos: cards with a title and notes that start a Claude session in a chosen folder and then follow it.
- Settings for theme, card size, notifications, the repo menu, to-dos, and whether new sessions skip permission prompts. They're off by default.
- A desktop launcher that starts the server in the background and opens the dashboard in its own window.
