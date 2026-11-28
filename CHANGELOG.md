# Changelog

Notable changes in each release. Version numbers follow [Semantic Versioning](https://semver.org). The release build takes each release's notes from its section here.

## Unreleased

- Sessions from Google Antigravity's command-line agent (`agy`) get cards: their status, including when they need your approval, the last prompt and reply, and the tool running. They're in History, Resume reopens them, and to-dos and the repo menu can start them. Needs Node 22.13 or later, which the desktop app has.
- To-dos and the repo menu start OpenCode and Cursor CLI sessions too: choose them in Settings → New sessions, the repo menu, or a to-do's **Start with**. A to-do's session is made before its window opens, so the to-do knows it from the start, and an OpenCode session is titled after the to-do.
- OpenCode's closed sessions stay in History after the dashboard restarts, including those that closed while it wasn't running, and Resume works on them.
- Each card shows where its time went, such as *Working 1h 12m · Needs you 4m · Idle 38m*, kept up to date. A Claude session's working time comes from the turn times Claude logs, so it's right from the first look; the rest are added up from what Tabherd sees and kept across restarts. ComfyUI jobs show their time queued.
- Sessions from more than one Claude account: Settings → Claude accounts lists your other `~/.claude-*` folders to watch, and takes any other Claude Code folder by its path. Each Claude card and History entry then says which folder it's in, a list in the header shows one account's sessions, and you choose the account new Claude sessions start with. Resume uses each session's own.

## 0.6.1 - 2026-11-26

Fixes for 0.6.0. Coming from 0.5.0? [0.6.0's notes](https://github.com/tleeadams/tabherd/releases/tag/v0.6.0) have what's new: the desktop app on macOS and Linux, OpenCode and Cursor CLI, tickets on cards, **Complete**, update alerts, and npm.

- **Windows:** run `tabherd-v0.6.1-windows-x64-setup.exe`. It installs over the version you have. It isn't code-signed yet, so SmartScreen may warn the first time: choose **More info**, then **Run anyway**.
- **macOS** (Apple silicon): open `tabherd-v0.6.1-macos-arm64.dmg` and drag Tabherd to Applications, replacing the one you have.
- **Linux:** install the new .deb or .rpm as you did the last, or use the new AppImage in place of the old.
- **npm:** `npm install -g tabherd@latest`, or `npx tabherd@latest`.

> **The macOS app isn't signed by Apple yet.** macOS asks before opening each new version you download: choose Done, then System Settings → Privacy & Security → *Open Anyway*. **When a version signed by Apple comes out, update to it**, and macOS stops asking.

What's fixed:

- Windows' list of installed apps, and the Linux packages, name Tabherd's publisher as tleeadams, not github.
- The update dialog showed a release note's quote or heading with its `>` or `#` in front.

## 0.6.0 - 2026-11-26

The desktop app comes to macOS and Linux, and Tabherd is on npm. Sessions from OpenCode and Cursor CLI get cards, tickets link to cards, and **Complete** closes work that's done. Below is everything since 0.5.0, including what the betas had.

- **Windows:** run `tabherd-v0.6.0-windows-x64-setup.exe`. It installs over the version you have. It isn't code-signed yet, so SmartScreen may warn the first time: choose **More info**, then **Run anyway**.
- **macOS** (Apple silicon): open `tabherd-v0.6.0-macos-arm64.dmg` and drag Tabherd to Applications. With Homebrew, `brew upgrade tabherd` updates the version that opens in your browser.
- **Linux:** install the .deb with `sudo apt install ./tabherd-v0.6.0-linux-x64.deb`, or the .rpm with `sudo dnf install ./tabherd-v0.6.0-linux-x64.rpm`, or make the AppImage executable (`chmod +x`) and run it. Use arm64 in place of x64 on an ARM computer.
- **Anywhere with Node 18 or later:** `npx tabherd@latest`.

> **The macOS app isn't signed by Apple yet.** It's signed ad hoc, so the first time you open it, and each new version you download, macOS says it can't check it: choose Done, then System Settings → Privacy & Security → *Open Anyway*. **When a version signed by Apple comes out, update to it.** From then on, macOS opens it without asking. Its release notes will say it's signed.

What's new since 0.5.0:

- **The desktop app comes to macOS and Linux:** a disk image for Apple silicon Macs, and a .deb, an .rpm and an AppImage for Linux, x64 and arm64, built on Ubuntu 22.04. They need WebKitGTK 4.1. As on Windows, it has a window of its own, starts the dashboard server unless one is running, and stops it on closing. The archives and Homebrew stay, for the dashboard in your browser. See [Install](README.md#macos-and-linux) and [docs/desktop-app.md](docs/desktop-app.md).
- The desktop app's window has no title bar of the system's: the dashboard's header stands in for it, with more room for the cards. Drag the header to move the window and double-click it to maximize. On Windows and Linux, minimize, maximize and close are in its top right corner; on macOS, the system's own buttons sit in its top left. The cards scroll below the header. See [docs/desktop-app.md](docs/desktop-app.md#the-window).
- **OpenCode** sessions get cards. They show *Working*, *Needs you* while OpenCode asks permission or a question, or *Idle*, with the last prompt and reply. **Go to window**, **Catch up**, **Stop**, **Complete** and Save and close work as they do for Codex. The dashboard asks OpenCode 2's background service, and matches each window to its session by its tab's title. See [OpenCode](README.md#opencode).
- **Cursor CLI** sessions get cards, matched to their windows by their tabs' titles. With Cursor's status indicators on (`/status-indicators`), they show *Needs you* while Cursor waits for an approval or an answer; otherwise *Working* or *Idle*, from the chat's transcript. **Go to window**, **Catch up**, **Stop**, **Complete**, Save and close, History and Resume work as they do for Claude. See [Cursor CLI](README.md#cursor-cli).
- **Complete** on a session's card, beside Stop…, for work that's done: after a second click it closes the session, once its turn ends if it's working, and History marks it *Completed*, with a switch to hide completed sessions. Save and close doesn't save a completed session, and one resumed and asked something new is no longer complete. See [Complete](README.md#complete).
- **Tickets on cards.** Add your Jira sites, Linear, GitHub Issues and Zendesk in Settings → Tickets, as many as you use, and **Test** each one's sign-in. Each session's card then shows its tickets, with their status, and opens them.
  - **Where they come from:** its branch's name, `Claim: ABC-123` lines in prompts or the session's replies (`Unclaim:` takes one off), ticket links in prompts, its to-do's new *Tickets* field, and **+ Ticket** on the card.
  - **What's linked:** a ticket is only linked if its tracker has it. ✕ takes one off.
  - **History** keeps each closed session's tickets, and finds sessions by them.
  - **A to-do from a ticket:** paste a ticket's link or key as a new to-do's title, and the to-do is filled in from it: the ticket's title, its description as the notes, and the ticket in *Tickets*. See [To-dos](README.md#to-dos).
  - **Complete** on a card with tickets opens a dialog first. It can comment on each ticket, with what the session did and its pull requests, and move it to done: a Jira transition, Linear's completed state, a GitHub issue closed as completed, or a Zendesk ticket solved. Nothing is posted unless it's ticked, and Zendesk comments are internal notes unless *Public reply* is ticked.
  - **Ticket done**, a new filter tab, shows the sessions whose tickets are all done or cancelled, still open. Any filter can pick by its cards' tickets: to do, in progress, done, cancelled, or none. It's added to the filters you already have, and shows once there's a tracker. See [What it shows](README.md#what-it-shows).
  - See [Tickets](README.md#tickets).
- **Secrets are encrypted** in `settings.json`: the trackers, with their addresses, emails and tokens, and LocalAI's key and LM Studio's token. The key is held by Windows (DPAPI), the macOS Keychain or your Linux keyring, so the file can't be read on another computer or by another user. Keys saved by older versions are encrypted on the first start. See [Secrets](README.md#secrets).
- **Update alerts:** Tabherd can tell you when a new version is out. It's off until you say yes, when the dashboard asks once or in Settings → Help, which also has **Check now**. With it on, the server asks GitHub for the latest release once a day, sending nothing about you or your sessions. A newer version brings an **Update to <version>** button to the header and a note to the notification list. The button shows what's new and how to update this copy: the command for Homebrew, npm, winget or a clone of the repository, or which download to get. **Not now** hides it until the next version. Prereleases, such as betas, are only mentioned if Settings → Help's *Tell me about betas and other prereleases too* is on, or to someone already running one. See [Update alerts](README.md#update-alerts).
- **On npm.** With Node 18 or later, `npx tabherd@latest` runs the dashboard on any system, or `npm install -g tabherd` adds a `tabherd` command. It starts the server in the terminal and opens the dashboard. See [With npm](README.md#with-npm).
- A LocalAI model that's working on a request, from LocalAI's chat or another app, gets a *Working* card. LocalAI doesn't list its requests, so the card goes by the processor the model's backend is using, and leaves a few seconds after it's quiet. One that worked half a minute or more dings when it stops.
- The version running shows under the computer's name in the header.
- With Card size set to Small, Medium or Large, the Memory and models card shrinks when its list of models is closed, instead of keeping a card's full height.
- Stop, Cancel and Unload on a job's, model's or download's card, and Unload on the Memory and models card, kept their first click only until the card next changed, which for a busy model could be within two seconds. The first click now lasts its three seconds whatever the card does.
- Intel Macs: the macOS desktop app is for Apple silicon only. The `macos-x64` download stays, but it won't be supported forever. We'll try to keep it updated until the official cutoff in 2029, but support may end sooner if it becomes too much for the team to keep up. See [Install](README.md#macos-and-linux).

## 0.6.0-beta.3 - 2026-11-25

A prerelease with everything since 0.6.0-beta.2, to try before 0.6.0: the app's own title bar, **Complete**, update alerts, a *Working* card for LocalAI, and the first part of linking tickets to cards.

- **Windows:** run `tabherd-v0.6.0-beta.3-windows-x64-setup.exe`. It installs over the version you have. It isn't code-signed yet, so SmartScreen may warn the first time: choose **More info**, then **Run anyway**.
- **macOS** (Apple silicon): open the disk image and drag Tabherd to Applications. The app isn't signed by Apple yet, so the first time you open it macOS says it can't check it: choose Done, then System Settings → Privacy & Security → *Open Anyway*.
- **Linux:** install the .deb with `sudo apt install ./tabherd-v0.6.0-beta.3-linux-x64.deb`, or the .rpm with `sudo dnf install ./tabherd-v0.6.0-beta.3-linux-x64.rpm`, or make the AppImage executable (`chmod +x`) and run it. Use arm64 in place of x64 on an ARM computer.

What's new:

- The desktop app's window has no title bar of the system's: the dashboard's header stands in for it, with more room for the cards. Drag the header to move the window and double-click it to maximize. On Windows and Linux, minimize, maximize and close are in its top right corner; on macOS, the system's own buttons sit in its top left. The cards scroll below the header. See [docs/desktop-app.md](docs/desktop-app.md#the-window).
- **Settings → Tickets**, the first step towards linking tickets to cards. Add your Jira sites, Linear, GitHub Issues and Zendesk, as many as you use, and **Test** each one's sign-in. See [the plan](docs/ticket-links.md).
- **Secrets are encrypted** in `settings.json`: the trackers, with their addresses, emails and tokens, and LocalAI's key and LM Studio's token. The key is held by Windows (DPAPI), the macOS Keychain or your Linux keyring, so the file can't be read on another computer or by another user. Keys saved by older versions are encrypted on the first start. See [Secrets](README.md#secrets).
- **Complete** on a session's card, beside Stop…, for work that's done: after a second click it closes the session, once its turn ends if it's working, and History marks it *Completed*, with a switch to hide completed sessions. Save and close doesn't save a completed session, and one resumed and asked something new is no longer complete. See [Complete](README.md#complete).
- Stop, Cancel and Unload on a job's, model's or download's card, and Unload on the Memory and models card, kept their first click only until the card next changed, which for a busy model could be within two seconds. The first click now lasts its three seconds whatever the card does.
- A LocalAI model that's working on a request, from LocalAI's chat or another app, gets a *Working* card. LocalAI doesn't list its requests, so the card goes by the processor the model's backend is using, and leaves a few seconds after it's quiet. One that worked half a minute or more dings when it stops.
- With Card size set to Small, Medium or Large, the Memory and models card shrinks when its list of models is closed, instead of keeping a card's full height.
- The version running shows under the computer's name in the header.
- Update alerts: Tabherd can tell you when a new version is out. It's off until you say yes, when the dashboard asks once or in Settings → Help, which also has **Check now**. With it on, the server asks GitHub for the latest release once a day, sending nothing about you or your sessions. A newer version brings an **Update to <version>** button to the header and a note to the notification list. The button shows what's new and how to update this copy: the command for Homebrew, winget or a clone of the repository, or which download to get. **Not now** hides it until the next version. Prereleases, such as betas, are only mentioned if Settings → Help's *Tell me about betas and other prereleases too* is on, or to someone already running one. See [Update alerts](README.md#update-alerts).

## 0.6.0-beta.2 - 2026-11-24

A prerelease, to try the desktop app on macOS and Linux before a release has it. On Windows it's the same as 0.5.0.

- **macOS** (Apple silicon): open the disk image and drag Tabherd to Applications. The app isn't signed by Apple yet, so the first time you open it macOS says it can't check it: choose Done, then System Settings → Privacy & Security → *Open Anyway*.
- **Linux:** install the .deb with `sudo apt install ./tabherd-v0.6.0-beta.2-linux-x64.deb`, or the .rpm with `sudo dnf install ./tabherd-v0.6.0-beta.2-linux-x64.rpm`, or make the AppImage executable (`chmod +x`) and run it. Use arm64 in place of x64 on an ARM computer.

What's new:

- The desktop app comes to Linux: a .deb, an .rpm and an AppImage, for x64 and arm64, built on Ubuntu 22.04. They need WebKitGTK 4.1. Prereleases have the macOS app too, for Apple silicon Macs, signed ad hoc until it can be signed and notarized: macOS asks before opening it the first time. See [docs/desktop-app.md](docs/desktop-app.md).
- Intel Macs: the macOS desktop app is for Apple silicon only. The `macos-x64` download stays, but it won't be supported forever. We'll try to keep it updated until the official cutoff in 2029, but support may end sooner if it becomes too much for the team to keep up. See [Install](README.md#macos-and-linux).

## 0.5.0 - 2026-11-24

- On Windows, Tabherd is a desktop app with a window of its own, in place of the launcher and its Edge window. It comes as an installer, which installs for you alone with no administrator rights and adds Tabherd to the Start menu, or as a zip. It starts the dashboard server unless one is running, and stops it on closing. Nothing from your browser shows in its window, and sound plays without a click first. Links open in your browser, and opening Tabherd again brings its window forward. Settings kept in the browser (Appearance, Notifications, Sections by group) start fresh once in the new window. See [Install](README.md#windows) and [docs/desktop-app.md](docs/desktop-app.md).
- In the desktop app, the pin in the header keeps the window on top of other windows, and Settings → Appearance → Window has the same, with **Transparency**, which lets what's behind the window show through its background and cards. Text, buttons and dialogs stay solid. Transparency is on Windows only for now.
- With Sections by group on, clicking a section's name closes it, hiding its cards, and clicking again opens it. A closed section still shows how many cards it has, and how many of its sessions need you. The browser remembers which are closed. See [Groups](README.md#groups).
- Each model on the Memory and models card shows the memory it takes, with how much is on the GPU where Ollama has put some of it in the computer's memory. Where the app doesn't say, as ComfyUI, LM Studio and llama.cpp don't, it's the model's size, marked ≈. The line above the models says how many there are and what they take together, and closes the list and opens it again. See [What it shows](README.md#what-it-shows).
- The dashboard speaks Spanish: Settings → Appearance → **Language** chooses English or Español, or *Automatic*, the default, which follows the browser. Changing it reloads the page. Durations, dates and sizes follow the language too. It's a first translation, and corrections are welcome. A few of the server's messages, those with details in them, stay English. See [Settings](README.md#settings).
- ComfyUI's loaded models join the Memory and models card, each with what it is and the workflow that loaded it, and Unload, which frees all of them, as ComfyUI does. They're the models its latest job's workflow names, since ComfyUI keeps those in memory for the next job. See [ComfyUI and LocalAI](README.md#comfyui-and-localai).
- The Memory and models card can stay in view: Settings → Appearance → *Keep it in view* holds it under the header while the cards below it scroll. It's off unless chosen, and kept in the browser.
- llama.cpp's server joins the Memory and models card: the model it has loaded, with its size, context and requests in progress, or in router mode each model loaded or loading, with Unload. Its address is in Settings → Other apps, else LLAMA_ARG_HOST and LLAMA_ARG_PORT, else port 8080. See [ComfyUI and LocalAI](README.md#comfyui-and-localai).
- A short tour on a browser's first visit points out each part of the dashboard, with Skip tour on every step. It waits until every running session is on the page, and the page holds still while it runs. With nothing running, it shows an example card. Browsers that have used the dashboard before don't get it, and Settings → Help shows it again. See [What it shows](README.md#what-it-shows).
- The filter tabs after All are yours to make, change, reorder and delete: the **⋯** menu after the tabs makes one or changes the one shown, and Settings → Filters lists them all. A filter picks statuses (Shell running among them, apart from Working), apps, groups and words in a card's name or folder, and whether to show to-dos. Todo, Needs you, Working and Idle are where they start, and Settings can put them back. The tab you're on is remembered. See [What it shows](README.md#what-it-shows).
- Settings shows one section at a time, picked from a list down its left side, and opens at the last one used.
- A **Memory and models** card across the top shows the memory in use against what the computer has, and each NVIDIA graphics card's, with the models loaded in LocalAI, Ollama and LM Studio, each with Unload. Loaded models no longer get cards of their own, unless the card is turned off in Settings → Appearance.
- Finished jobs, chats and downloads leave the dashboard as soon as they're done, instead of staying a few minutes. The ding and the notification list still say so, with the output image for a ComfyUI job. Failed ones stay, as needing you, until cleared with **Clear**.
- GitHub Copilot's sessions, from the Copilot CLI and from VS Code's agent, get cards marked **Copilot**: status, with *Needs you* while an approval is unanswered, the last prompt and reply, tools, model and tokens. CLI sessions have Go to window, Catch up and Stop, can be started from to-dos and the repo menu with their own ID and name, and are in History with Resume. See [GitHub Copilot](README.md#github-copilot).
- Ollama's and LM Studio's loaded models are listed, with their size, context and Unload, and Ollama's with the graphics memory each holds and when it will unload. Their addresses, and an LM Studio token, are in Settings → Other apps.
- **Save and close all**, in a new menu in the header, saves every open Claude and Codex session and closes it, tab and all, after asking. Sessions still working can be waited for, closing as each finishes its turn, or closed at once. **Resume last session** opens them all again, each carrying on its conversation. On Windows the tab closes because `exit` is typed into its shell once the session has ended, so Windows Terminal closes it as usual. See [Save and close](README.md#save-and-close).
- ComfyUI's jobs and LocalAI's models, downloads, agent chats and agent jobs show as cards, marked **Comfy** and **LocalAI**, and join the app list in the header. A ComfyUI job shows as Working, with its progress on Windows, Queued with its place, or Finished with its output image, and has Stop or Cancel and Go to window. A LocalAI model shows the memory it's using and has Unload; downloads show their progress and have Cancel; agent chats show as Working, or Needs you when paused, and have Stop. Finishing dings. Settings → Other apps has ComfyUI's and LocalAI's addresses, and LocalAI's API key; Comfy Desktop's ComfyUIs are found by themselves, on whatever port. See [ComfyUI and LocalAI](README.md#comfyui-and-localai).
- On Windows, the title-reading helper also reads the main window title of apps without a console, which is how Comfy Desktop's progress is read.
- A to-do's **Delete?**, the second click it asks for, is readable: it was red text on red. In dark mode, every button asking for a second click is a deeper red, which white text reads better on.

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
