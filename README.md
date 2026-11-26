<p align="center"><img src="public/icons/tabherd-128.png" width="96" height="96" alt="Tabherd"></p>

# Tabherd

**A dashboard for your Claude Code and Codex sessions.** Tabherd lists every [Claude Code](https://code.claude.com) and [Codex](https://github.com/openai/codex) session running on your computer and shows what each one is doing: which ones need you, which are working, and what they last said. It watches the sessions you start anyway, in any terminal, with nothing to set up in either. It runs entirely on your computer and has no dependencies beyond Node.

Tabherd is an independent project. It isn't made or endorsed by Anthropic or OpenAI. It was called Claude Agents up to version 0.1.2. Say it "Tab Herd" or "tabberd": both are right.

## Install

Each [release](../../releases/latest) has a download for Windows, macOS (Apple silicon `arm64`, Intel `x64`) and Linux (`x64`, `arm64`). Each includes Node, so there's nothing else to install, and has a `.sha256` file beside it for checking the download.

### Windows

On Windows, Tabherd is a desktop app with a window of its own.

- **With the installer:** download `tabherd-v<version>-windows-x64-setup.exe` and run it. It installs for you alone, without asking for administrator rights, into `%LOCALAPPDATA%\Tabherd`, and adds Tabherd to the Start menu.
- **From the zip,** without installing: download `tabherd-v<version>-windows-x64.zip` and extract it somewhere to keep it, such as `%LOCALAPPDATA%\Programs`. It holds one folder, `tabherd-windows-x64`. Run **Tabherd.exe** in it.

Neither is code-signed yet: signing through SignPath Foundation is waiting on their approval (see the [code signing policy](#code-signing-policy)). Until then, Windows SmartScreen may warn about them the first time. Choose **More info**, then **Run anyway**.

Tabherd starts the dashboard server in the background, with no console window, unless one is already running. It shows the dashboard in WebView2, the engine Edge uses, which comes with Windows. Nothing from your browser shows in its window, and sound plays without a click first. Links to pull requests and other sites open in your browser. Opening Tabherd while it's open brings its window to the front. Closing the window stops the server it started.

The header is the window's title bar: drag it to move the window, double-click it to maximize, and minimize, maximize and close are in its top right corner. The pin in the header keeps the window on top of other windows. Settings → Appearance → **Window** has the same, as *Keep on top*, and **Transparency**, which lets what's behind the window show through its background and cards, up to 80%. Text, buttons and dialogs stay solid. Both are only in the app, not in a browser.

### macOS and Linux

With [Homebrew](https://brew.sh):

```
brew install tleeadams/tap/tabherd
```

Then run `tabherd`. `tabherd --install` adds Tabherd to Applications on macOS, or to the applications menu on Linux, and `brew upgrade` keeps it current. It uses Homebrew's Node.

Or from a download:

1. Download `tabherd-v<version>-macos-arm64.tar.gz`, or the one for your system, and unpack it somewhere to keep it: `tar -xzf tabherd-v*.tar.gz -C ~/.local/share`. That makes the folder `~/.local/share/tabherd-macos-arm64`.
2. Run `./tabherd` in that folder.
3. To add Tabherd to your applications, run `./tabherd --install`: on macOS that's **Tabherd** in `~/Applications`, on Linux an entry in the applications menu. Both also add a `tabherd` command in `~/.local/bin`. `./tabherd --uninstall` removes them again.

**Intel Macs:** the `macos-x64` download won't be supported forever. We'll try to keep it updated until the official cutoff in 2029, but support may end sooner if it becomes too much for the team to keep up. The macOS desktop app is for Apple silicon only.

`tabherd` starts the dashboard server in the background if it isn't running, then opens the dashboard: as an app window, with no tabs or address bar, if Chrome, Edge, Brave, Chromium or Vivaldi is installed, otherwise in your browser.

### Updating and uninstalling

On macOS and Linux, a server started by `tabherd` stops by itself 10 minutes after the last dashboard closes, and the next launch starts it again in a couple of seconds.

The dashboard can tell you when a new version is out, and how to update; see [Update alerts](#update-alerts).

To update on Windows, run the new release's installer, which installs over the old one. From the zip, replace the folder with the new release's. On macOS and Linux, replace the folder; its name doesn't change between releases, so the `tabherd` command and its entry in your applications keep working. Settings, history and to-dos are kept in `~/.tabherd`, outside the app.

To uninstall on Windows, use Settings › Apps › Installed apps, or delete the zip's folder. On macOS and Linux, run `./tabherd --uninstall`, then delete the folder. Delete `~/.tabherd` too unless you want to keep your settings, history and to-dos.

## Run from source

With Node 18 or later, on any operating system:

```
npm start          # serve on http://localhost:4317 and open the browser
npm run serve      # serve without opening a browser
npm run check      # print a one-off table in the terminal
```

Set `PORT` to use another port. Set `CLAUDE_CONFIG_DIR` if your Claude config isn't in `~/.claude`. The server keeps its own settings in `~/.tabherd`; set `TABHERD_DATA_DIR` to use another folder.

The same launcher and shortcuts as a release can be set up from the source:

```
npm run install-shortcut     # add Tabherd to the Start menu, Applications or applications menu
npm run uninstall-shortcut   # remove it again
```

On Windows the launcher is a small C# program (`launcher/Tabherd.cs`), compiled with the C# compiler that comes with Windows, with its icon made from the logo. It opens the dashboard in an Edge app window. Run the install again after moving the folder or switching Node versions; it records which `node.exe` to use. On macOS and Linux it's a shell script, `launcher/tabherd.sh`, which uses the `node` on your PATH.

The desktop app is in `app/src-tauri`, built with [Tauri](https://tauri.app). Building it needs [Rust](https://rustup.rs): on Windows its MSVC toolchain (`rustup default stable-msvc`), with Visual Studio's C++ build tools; on Linux, WebKitGTK and the other libraries in [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/). Then:

```
node scripts/stage-app.js    # put this Node beside the app as its server's Node, and make its icons
cd app/src-tauri
cargo run                    # build and open it; it starts a server unless one is running on PORT
```

`npm run build` builds the Windows release, the installer and the zip, with Tauri's command-line tool: `cargo tauri` if it's installed (`cargo install tauri-cli --version "^2" --locked`), otherwise its npm package. The design is in [docs/desktop-app.md](docs/desktop-app.md).

## Platform support

The dashboard itself (session cards, statuses, filters, sounds, notifications, history, to-dos and settings) is plain Node and runs the same on Windows, macOS and Linux. What differs is driving terminals: **Go to window**, **Catch up**, tab titles on the cards, and opening Claude from the repo menu, Resume and to-dos. Each terminal app offers different controls:

| Terminal | Opens Claude in | Go to window | Catch up | Tab titles |
| --- | --- | --- | --- | --- |
| Windows Terminal | a tab | the exact tab | yes | yes |
| macOS Terminal | a window | the exact tab | yes | partly |
| iTerm2 | a tab | the exact tab | yes | yes |
| Ghostty, macOS (1.4+) | a tab | the exact tab | yes | yes |
| Ghostty, Linux | a tab (1.4+) or window | the exact tab (1.4+) | in tmux | in tmux |
| kitty | a tab | the exact tab | yes | yes |
| WezTerm | a tab | the exact tab | yes | yes |
| GNOME Terminal | a tab | the exact tab | in tmux | yes |
| Ptyxis | a tab | the window | in tmux | in tmux |
| Konsole | a tab | the exact tab | yes | in tmux |
| tmux, in any terminal | a window | the exact pane | yes | yes |

"In tmux" means it works when the session runs inside tmux, whatever the terminal. A few need a setting first:

- **macOS**: the first time Tabherd drives Terminal, iTerm2 or Ghostty, macOS asks whether to allow it, naming the app Tabherd was started from. If it was refused, turn it on in System Settings › Privacy & Security › Automation. Terminal can't open a tab from a script, so it opens a window.
- **kitty**: remote control is off until `kitty.conf` has `allow_remote_control socket-only` and `listen_on unix:/tmp/kitty`, and kitty is restarted.
- **Konsole 25.12 and later** block typing into tabs until Configure Konsole › General › *Enable the security sensitive parts of the DBus API* is on.
- **Linux on Wayland**: GNOME doesn't let one app bring another's window forward, so Go to window switches to the tab and GNOME shows that the window is ready. KDE brings it forward.

Settings › New sessions › **Terminal** chooses where Claude opens; *Automatic* uses one this computer has. `npm run check-terminals` checks every terminal found on this computer with a stand-in session, not Claude, and prints what works.

Checked that way so far: Windows Terminal; tmux, kitty, WezTerm, GNOME Terminal and Konsole on Ubuntu 24.04; and Terminal, iTerm2, Ghostty, kitty, WezTerm and tmux on macOS, where a workflow repeats the check whenever the drivers change, except for kitty and WezTerm, which can't run there. Not yet checked: Ghostty and Ptyxis on Linux.


## What it shows

The header names the computer the dashboard runs on, with the version of Tabherd running under it.

The first time a browser opens the dashboard, a short tour points out each part of it, with **Skip tour** on every step, or Esc. It starts once every running session is on the page, and the page holds still while it runs: the cards don't update and only the tour can be clicked, though dings and notifications carry on. With no sessions running, it shows an example card, marked as one, which goes when the tour ends. A browser that has used the dashboard before doesn't get it. Settings → **Help** shows it again.

- **Status**: *Needs you* (blocked on a prompt or dialog), *Working*, *Shell running* (at the prompt while a background shell runs) or *Idle*, plus how long it has been in that state.
- **Activity**: the tools running now and for how long, the latest message or recap, and the last prompt. Click a message to expand it.
- **Model and tokens**: the model, how full the context window is, output tokens and number of prompts.
- **Subagents**: running subagents with their current step, then recently finished ones.
- **Actions**: go to the session's window, catch up, open its folder, copy a `claude --resume` command, or stop the session. Clicking a session's name also goes to its window.

A card across the top, **Memory and models**, shows the computer's memory in use against what it has, and each NVIDIA graphics card's, from `nvidia-smi` when it's there. Under them it lists the models loaded in ComfyUI, LocalAI, Ollama, LM Studio and llama.cpp, each with the memory it takes and **Unload** where the app allows it. Where the app doesn't say what a model takes, as ComfyUI, LM Studio and llama.cpp don't, it's the model's size, marked ≈, as that's about what it takes; where some of an Ollama model is in the computer's memory rather than graphics memory, the line says how much is on the GPU. The line above the models, with how many there are and what they take together, closes the list and opens it again, which the browser remembers. It shows whatever the filter. Settings → Appearance → *Keep it in view* keeps it under the header while the cards below it scroll, with a long list of models scrolling inside it. *Memory and models* turns it off, and each loaded model then gets a card of its own, shown under All.

The tabs in the header filter the cards. **All** shows everything. The others are yours to change, and start as **Todo** (*Needs you* and *Idle*, with the to-do cards: everything whose turn it is), **Needs you**, **Working** and **Idle**. *Queued* counts as Working, and so does *Shell running* on the Working tab, though a filter can pick Shell running on its own. Each tab counts its cards, in amber when one of them needs you.

- **Make one** from the **⋯** menu after the tabs, with **New filter…**. A filter picks statuses, apps and groups, and words that must be in the card's name or folder. A row with nothing ticked matches any. To-dos have no status, so a filter shows them only when *Show to-dos* is ticked, and then only those from its apps, in its groups and with its words.
- **Change or delete one**: the same menu's **Edit** changes the tab you're on, and **Edit filters…** opens Settings → **Filters**, which lists them all to change, delete or move up and down the tabs, and has **Restore the usual filters** to put back the four above.

Filters are saved in `~/.tabherd/filters.json`, for every browser. The tab you're on is remembered in the browser.

Each card says which app the session is, **Claude** or **Codex**. Once a Codex session is running, a list beside the filters shows only one app's sessions, and once there are [groups](#groups), another shows one group, or the sessions in none. The counts on the filters follow both lists, and both are remembered in the browser.

## Codex

Codex sessions get cards like Claude's, marked **Codex** (Claude's are marked **Claude**), and the dashboard does the same for them as for Claude's. Nothing needs setting up in Codex, and nothing changes if Codex isn't installed.

- **Status** comes from Codex's background service, which runs your Codex sessions and reports each one's state as it changes: *Needs you* when it's waiting for an approval or an answer, *Working* or *Idle*. Tabherd connects to it through `codex app-server proxy`, and only once the service is running, so it never starts the service itself. It never answers an approval: Codex asks those in the session's window.
- **Activity, model and tokens** come from the session's file in `~/.codex/sessions` (or `$CODEX_HOME/sessions`), read a few new bytes at a time like a Claude transcript. A session's subagents are listed on its card, as Claude's are.
- **Go to window** finds the session's tab by its title, which Codex sets to the session's name. A session Codex hasn't named yet is matched only when it's the one unmatched Codex window, so until then its card has no Go to window.
- **Catch up** sends the question with `codex queue`, through Codex's service, and brings the window forward if it's known. Nothing is typed into the window, so nothing there can be answered by it. An idle session starts on it at once, a busy one after its current turn.
- **Stop** interrupts the turn the session is running, then ends the Codex in its window. If the window isn't known, it interrupts the turn and says to close the window yourself.
- **Starting Codex**: the repo menu and to-dos start Claude or Codex, as Settings → New sessions says. The repo menu has the same choice at its top, and a to-do can name its own. A Codex to-do opens `codex` in its folder. Codex chooses its session's ID itself, so the dashboard links the to-do to the first session that starts in that folder within a minute, and names that session after the to-do.
- **History** lists closed Codex sessions too, and **Resume** opens your terminal in the session's folder running `codex resume <id>`.

With *Skip permission prompts* on, Codex sessions the dashboard opens or resumes run with `--dangerously-bypass-approvals-and-sandbox`. A session Codex runs outside its background service, such as one in an Administrator terminal or started with `--profile` or most `-c` options, isn't shown. When a Codex window closes, its card goes at once if the dashboard knew the window, or within about a minute, when Codex unloads the session, if it didn't.

## Background runs

Sessions run headless, with `claude -p`, show too: a background PR review, say, or a scheduled job. Claude registers them as it does sessions in a terminal, so Tabherd tells them apart by how they were started (`claude -p`, or the Agent SDK) and marks their cards **Background**. They have no window, so their cards have no Go to window or Catch up. Stop still ends them.

A background run doesn't wait at a prompt when it's done: it exits. When one the dashboard saw running exits, it dings as finished, unless you stopped it, and its notification reads *Finished in the background*. Clicking its name there resumes it in a terminal tab, running `claude --resume <id>` in its folder, so you can ask about what it did. History lists background runs too, tagged **Background**, and its **Background runs** switch hides them, for when scripts run `claude -p` often.

## GitHub Copilot

GitHub Copilot's sessions get cards marked **Copilot**: the Copilot CLI's, and the agent sessions VS Code runs on the same Copilot runtime, which keep their state in the same place, `~/.copilot/session-state` (or `$COPILOT_HOME`).

- **Which sessions are open** comes from Copilot's own list of open sessions and the lock each one's process holds. A lock left by a process that's gone doesn't count.
- **Status**: *Needs you* while an approval Copilot asked for is unanswered, or while its ask_user tool waits for an answer; *Working* while Copilot's list says so, or a turn or tool is running; otherwise *Idle*.
- **Activity**: the last prompt and reply, the tools running, the model and output tokens, from the session's `events.jsonl`, read a few new bytes at a time.
- **Go to window**, **Catch up** and **Stop** work for the CLI as they do for Claude. A VS Code session runs inside VS Code, with all its others, so its card only has Go to window, which brings up VS Code.
- **Starting Copilot**: once the Copilot CLI is installed, Settings → New sessions, the repo menu and a to-do's *Start with* offer it. A to-do starts `copilot --session-id=<new id> --name "<the to-do's title>"`, so, as with Claude, the server knows which session the to-do became.
- **History and Resume**: the CLI's closed sessions are listed, and Resume runs `copilot --resume=<id>`. *Skip permission prompts* adds `--allow-all`. Save and close takes CLI sessions too.

## OpenCode

OpenCode's sessions get cards marked **OpenCode**. OpenCode 2 runs a background service that all its windows use, and the dashboard asks it what each session is doing. The service's address and password are in `~/.local/state/opencode/service.json` (or under `$XDG_STATE_HOME`). The password only goes to a service on this computer.

- **Which sessions have cards:** each one an OpenCode window shows, and any that's working or waiting on you without one. A window is matched to its session by its tab's title, which OpenCode sets to *OC | <the session's title>*, or by the `--session` it was started with. When two sessions share a title, neither is guessed.
- **Status:** *Needs you* while it asks permission or a question; *Working* while a turn runs; otherwise *Idle*. A turn that failed needs you too.
- **Activity:** the last prompt and reply, the model and output tokens.
- **Catch up** sends its prompt through the service, as Codex's does, so nothing is typed into the window. **Stop** interrupts the turn, then ends OpenCode in its window. **Complete** and Save and close take OpenCode sessions too.
- **Resume:** `opencode --session <id>`. *Skip permission prompts* adds `--auto`.
- **Not yet:** starting OpenCode from a to-do or the repo menu, and OpenCode's closed sessions in History.

## Cursor CLI

The Cursor CLI's sessions (`cursor-agent`) get cards marked **Cursor**. Cursor keeps each chat in `~/.cursor/chats/`, with a `meta.json` giving its folder and title, and writes what's asked and answered to a transcript in `~/.cursor/projects/<folder>/agent-transcripts/`. `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` move them, as they do for Cursor.

- **Which chats have cards:** each one a `cursor-agent` window shows. Cursor records no process for a chat, so a window is matched to its chat by its tab's title, which Cursor sets to the chat's title, or by the `--resume` it was started with. A new chat has no title until its first prompt, so until then its window goes with the chat begun in it since it started. When two chats share a title, neither is guessed.
- **Status:** turn on Cursor's status indicators, with `/status-indicators` in any Cursor window, and its tab titles say whether it's working, waiting for you or ready. The dashboard then shows *Needs you* while Cursor waits for an approval, with the command it wants to run, or for your answer. Without them, it only knows from the transcript whether a turn is running, so a chat waiting on an approval shows *Working*. A turn that failed needs you too.
- **Activity:** the last prompt and reply, and the tool calls of the step running. Cursor's transcript has no times, so the reply's time is when the dashboard read it.
- **Go to window**, **Catch up** and **Stop** work as they do for Claude: Catch up types its prompt into the window. **Complete** and Save and close take Cursor chats too.
- **History and Resume:** closed chats are listed, and Resume runs `cursor-agent --resume <id>` in the chat's folder, where Cursor keeps it. *Skip permission prompts* adds `--force`.
- **Not yet:** starting Cursor from a to-do or the repo menu, and subagents.

## ComfyUI and LocalAI

The dashboard also shows what ComfyUI and LocalAI are doing, as cards marked **Comfy** and **LocalAI**. They join the app list in the header once they have something to show. Nothing needs setting up in either, unless LocalAI has an API key.

**ComfyUI.** Comfy Desktop keeps a record of each ComfyUI it runs, with its port, so every installation that's running is found, whatever its port. A ComfyUI run some other way is looked for at Settings → Other apps → *ComfyUI address*, `http://127.0.0.1:8188` unless you set another. Each job gets a card:

- **Working**, the job running now. Comfy Desktop's window title gives its progress, which goes on the card as a bar on Windows. ComfyUI only sends progress to the window that queued a job, so there's no other way to see it.
- **Queued**, with its place in the queue.
- **Finished** jobs leave the dashboard at once. Finishing dings, and the notification list says it finished, with its first output image. A **Failed** job keeps its card, with the error, as needing you, until you **Clear** it.

A job is named after its saved workflow; one queued from an unsaved workflow is called *Unsaved workflow*. **Go to window** brings up Comfy Desktop. **Stop** ends the running job and **Cancel** takes a queued one out of the queue, each after a second click. The output images come through the dashboard's own server, which only passes on those of jobs it has reported, for a day.

The models ComfyUI has loaded are listed on the Memory and models card, each with what it is (diffusion model, text encoder, VAE, LoRA and so on), the workflow that loaded it, and the size of its file, which is about what it takes in memory. ComfyUI doesn't list them itself. They're the model files named in the latest job's workflow, which ComfyUI keeps in memory after the job for the next one. **Unload** frees them, all at once, as ComfyUI only frees them all together. They're listed again once another job runs. If ComfyUI frees them itself, to make room or from its own menu, the list doesn't know until the next job.

**LocalAI.** It's found at Settings → Other apps → *LocalAI address*, `http://127.0.0.1:8080` unless you set another, with the API key there if LocalAI has one. It shows:

- **Each loaded model**, on the Memory and models card, with the graphics memory, memory and CPU it's using, and **Unload** to free them.
- **Each model that's working**, on a request from LocalAI's own chat or from another app, as a *Working* card of its own. LocalAI doesn't list the requests it's answering, so this goes by the processor its model's backend is using, which is near zero when it's idle: the card comes when it's busy and leaves a few seconds after it's quiet again. One that worked half a minute or more dings when it stops. A model on another computer, through LocalAI's distributed mode, gets no reading, so no card.
- **Each download or install** in progress, with its progress and size, and **Cancel**. Finishing dings.
- **Each agent chat** that's running (*Working*, with **Stop**) or paused at its step limit (*Needs you*). One that finishes leaves the dashboard and dings.
- **Each agent job** running or queued, with **Cancel**. One that finishes leaves and dings.

A chat, agent job or download that fails keeps its card, as needing you, until you **Clear** it. Cleared cards stay cleared, in every browser, in `~/.tabherd/dismissed.json`.

**Open in LocalAI** opens LocalAI's own page.

**Ollama** and **LM Studio**: each loaded model is listed on the Memory and models card, marked with its app, with its size, context and, for Ollama, the graphics memory it holds and when Ollama will unload it, and **Unload**. Ollama is found at Settings → Other apps → *Ollama address*, else `OLLAMA_HOST`, else `http://127.0.0.1:11434`. LM Studio's local server must be on (its Developer tab, or `lms server start`); it's found at *LM Studio address*, else the port it last served on, else `http://127.0.0.1:1234`, with *LM Studio API token* if LM Studio requires one. Neither tells anyone but the caller about downloads or requests in progress, so those don't get cards.

**llama.cpp**: the model llama.cpp's server (`llama-server`) has loaded is listed on the Memory and models card too, with its size, context, quantization and how many requests it's answering at once. In router mode (`--models-dir` or `--models-preset`), each model loaded or loading is listed, and **Unload** unloads one; a server started with one model (`-m`) keeps it until it's stopped, so it has no Unload. It's found at Settings → Other apps → *llama.cpp address*, else `LLAMA_ARG_HOST` and `LLAMA_ARG_PORT`, else `http://127.0.0.1:8080`. LocalAI's default is the same port; Tabherd tells the two apart by what they answer, so whichever is running there shows.

## Groups

Groups gather sessions by project, client or anything else, each with a name and a colour. Make them in Settings → **Groups**, or from a card: its group button, which reads *No group* while the card is pointed at, has **New group for** the card's folder.

- **By folder.** A group has folders, and a session or to-do in one of them, or in a folder inside it, is in that group. If several groups' folders hold it, the nearest folder wins. New sessions there join with nothing to do. A to-do without a folder goes by the folder it will start in.
- **By hand.** The group button on a card moves that session or to-do to another group, or to none. It stays there, kept by its session ID so it's still there when resumed, until **Follow its folder again**. A to-do moved by hand passes its group on to the session it starts.
- **On the card.** The group's colour runs along the top of the card, and its name is on the button. The left edge still shows the status. History shows each session's group, and the repo menu marks a group's folders with a dot in its colour.
- **Sections.** Settings → Groups → **Sections by group** puts each group's cards under its name, in the order the groups are listed, with the sessions in no group last. Clicking a section's name closes it, hiding its cards, and clicking again opens it. A closed section still shows how many cards it has, and how many of its sessions need you. The browser remembers which are closed.

The colours are a set of eight, each tuned for light and dark and kept apart from the status colours. In Settings, a group's folder box suggests the folders and repos from the repo menu, and takes any full path, with `~` for your home folder. Groups are saved in `~/.tabherd/groups.json`, for every browser.

## To-dos

**+ To-do** in the header adds a card with a title and notes, for work you want to give Claude later. To-do cards sit at the top of the grid, with a dashed border, and count under All and Todo. Ctrl+Enter saves from the notes box.

With a tracker in Settings → Tickets, pasting a ticket's link or key as a new to-do's title fills it in from the ticket: the ticket's title, its description as the notes if they're empty, and the ticket in *Tickets*, so the session starts linked to it. The line under the title says which ticket it came from, or why it couldn't. Jira Cloud's descriptions come as text, with lists, links and code kept. See [Tickets](#tickets).

**Start** opens Claude in the to-do's folder, in your terminal, running `claude --session-id <new id> --name "<the to-do's title>"`, so the session is named after the to-do in its tab's title and Claude's session list. Once Codex is installed, the to-do's **Start with** chooses Claude or Codex, or leaves it to Settings; for Codex, see [Codex](#codex). A to-do doesn't need a folder: without one, it starts in Settings → To-dos → **Start in**, your repos folder unless you set another, where Claude can make a new project. The card says where it will start.

**Choose folder** picks one first, from where Settings → To-dos says:

- **Repo menu** (the default): the ☰ menu opens for choosing. Click a repo.
- **Any folder**: the system's folder picker (zenity or kdialog on Linux), which the server opens in front of the dashboard.

Both open at **Start in**.

The server makes up the session ID, so it knows which session the to-do turned into. Once that session appears, its card replaces the to-do's, with the to-do's title and notes at the top and **Copy** to paste them into Claude. Nothing is typed into Claude for you. If no session turns up within a minute, the to-do's card says so and offers **Start again**.

When the session closes, the to-do goes too. Its title and notes stay with the session in History, and resuming the session brings the to-do back on its card. A session closed before Claude was asked anything has nothing to resume, so its to-do comes back to its own card instead, with its folder, ready to start again. **Delete** asks for a second click. To-dos are saved in `~/.tabherd/todos.json`.

## Settings

The gear button in the header opens Settings, one section at a time, picked from the list down its left side. It opens at the section last used.

**New sessions**: once Codex is installed, *Claude* or *Codex* chooses the app the repo menu opens, and to-dos start in unless they name one. *Skip permission prompts* (off by default) makes every session the dashboard opens, from the repo menu, Resume or a to-do, run `claude --dangerously-skip-permissions`, or `codex --dangerously-bypass-approvals-and-sandbox`. They then edit files and run commands without asking first. Only turn it on if you'd run them that way yourself in those folders. *Terminal* chooses which terminal they open in, where there's more than one; see [Platform support](#platform-support).

**Appearance** has *Language*, *Theme*, *Card size* and the *Memory and models* card, which can be turned off. **Language**: *Automatic* (the default) follows the browser's languages, and *English* or *Español* sets one. Changing it reloads the page. The Spanish is a first translation, so some of it may read oddly; corrections are welcome. A few of the server's messages, those with details in them, stay English. **Theme**: *System* (the default) follows the system's light or dark mode. *Light* or *Dark* sets one regardless.

**Card size** sets how the cards are laid out:

- **Fit content** (the default): each card is as tall as its content, so cards in a row can differ.
- **Small**, **Medium** or **Large**: every card is the same size. Small fits the most on screen, Medium is about as wide as Fit content, and Large leaves room for subagents and PRs. Each header line stays on one line and is cut off with "…" if it's too long; the full path is in the tooltip. The buttons stay at the bottom, and anything that doesn't fit in between scrolls inside the card, with a shadow at the edge showing there's more.

**Notifications**: *Keep the list after a reload* (on by default) saves the notification list, so reloading or reopening the dashboard keeps it.

**Filters**: the tabs after All, in their order, each with what it shows, to move, change or delete; **Add filter**; and **Restore the usual filters**. See [What it shows](#what-it-shows).

**Groups**: each group's name, colour and folders, and *Sections by group*. See [Groups](#groups).

**Other apps**: ComfyUI's, LocalAI's, Ollama's, LM Studio's and llama.cpp's addresses, and LocalAI's API key and LM Studio's token. The key and token are kept encrypted (see [Secrets](#secrets)) and never sent back to the page. See [ComfyUI and LocalAI](#comfyui-and-localai).

**Tickets**: the ticket systems, or trackers, that sessions will be linked to: Jira sites, Linear, GitHub Issues and Zendesk, as many as you use. **Add a tracker** asks for what its type needs:
- **Jira:** the site's address, an email and API token, and optionally its projects' key prefixes. Leave the email empty for a Data Center personal access token.
- **Linear:** a personal API key, and optionally team key prefixes.
- **GitHub Issues:** nothing; it uses `gh`'s sign-in.
- **Zendesk:** the address, and an email and API token, or an OAuth access token.

**Test** signs in and says as whom, or what's wrong; a tracker is tested as it's saved. **Edit** keeps the saved token unless you type a new one, and **Remove** asks for a second click. A tracker whose last lookup failed says why. See [Tickets](#tickets) for linking them to cards.

**To-dos**: where a to-do's folder is chosen from (the repo menu or any folder), and the folder that choice starts at. See [To-dos](#to-dos).

**Repo menu**: every folder and repo under the repos folder, nested as in the ☰ menu, each with a tick box. Untick one to hide it, and everything inside it, from the menu. What's inside a hidden folder is greyed out but keeps its own setting, so ticking the folder again brings back exactly what was shown before. A folder with some repos hidden says how many, in amber. The filter box works like the menu's. A hidden path that's no longer in the repos folder is listed underneath, with ✕ to remove it.

**Help**: *Show the tour* shows the first-run tour again. See [What it shows](#what-it-shows). *Tell me when a new version is out* turns update alerts on or off, *Tell me about betas and other prereleases too* includes prereleases, and **Check now** checks at once. See [Update alerts](#update-alerts).

Appearance, Notifications and Sections by group are saved in the browser, so each browser profile remembers its own choice. The rest are saved by the server, in `~/.tabherd/settings.json`, `~/.tabherd/filters.json` and `~/.tabherd/groups.json`, so every browser shares them.

## Catch up

**Catch up** goes to the session's window and asks: *"Catch me up: where do things stand? Briefly cover what's done, what's in progress, and anything you need from me."* Set `CATCH_UP_PROMPT` to change the wording. The server holds the prompt, so the API can't be used to type anything else into an agent.

The keystrokes go to that session only, never to whichever window has focus, so they can't land in the wrong place. On Windows they go straight into the session's console input, with Enter sent on its own a moment after the text. On macOS and Linux the terminal's own scripting, or tmux, types into the session's tab: the prompt is marked as a paste and Enter follows it. Either way Claude Code submits the prompt rather than treating Enter as part of a paste. If the session is busy, Claude Code queues the question until its current step finishes.

Catch up is disabled while a session is waiting on a permission prompt or dialog, where typing and Enter could answer it. The script checks the session's status again just before typing. If you've half-typed something in that session's prompt box, the question is added to the end of it and sent with it.

A Codex session gets the question through Codex's own service instead, without typing; see [Codex](#codex).

## Dings

The page plays a sound when an agent changes state:

- **Needs you** (it starts waiting on a prompt or dialog): two rising notes.
- **Finished** (Working to Idle, or to "Shell running" at the prompt, or a [background run](#background-runs) ending): one soft bell.

A toast says which agent it was, and its card pulses. If several agents change at once you hear one sound, and sounds are at least 2 seconds apart.

Each change is also added to the notification list, the tray button left of the bell, so it can still be read after the toast fades. The button shows how many entries there are, in amber if any agent needs you. Each entry names the agent, which links to its window, and says what happened and when. Clear entries with ✕ or **Clear all**. An entry also clears itself once its agent is working again, and a *needs you* entry clears once that agent stops waiting. The list keeps one entry per agent, the latest. An agent that closes keeps its entry, marked *session closed*. The sounds are synthesized in the page, so there are no audio files. The bell button in the header turns sound on or off, and the setting is remembered.

Browsers only let a page play sound after you've clicked or typed in it, so after opening or reloading the dashboard the bell reads **Click to enable sound** until you click anywhere on the page. To skip that, allowing media autoplay for `http://localhost:4317` in Edge (Settings → Cookies and site permissions → Media autoplay) should let it play straight away.

The server pushes each update to open dashboards (`/api/stream`, server-sent events) instead of the page checking every few seconds. A browser slows timers in hidden or covered windows to as little as once a minute, which would make dings late. Pushed messages are handled right away.

## Update alerts

Tabherd can tell you when a new version is out. It's off until you say yes:
- **Asking:** the dashboard asks once, above the cards, after the first-run tour. The answer is kept by the server, so no other browser asks again.
- **Changing it:** Settings → Help turns it on or off.
- **What it sends:** with it on, the server asks GitHub for Tabherd's list of releases when it starts, then once a day, or an hour after a check that failed. Nothing about you, your computer or your sessions is sent. GitHub sees a request from your address, as it does for any web page.
- **Check now:** in Settings → Help, it asks straight away, on or off.

When there's a newer version:
- **The header** gets an **Update to <version>** button, and the notification list says so once.
- **The button** shows what's new, from the release's notes on GitHub, which are in English. It also says how to update this copy: the command for Homebrew, winget or a clone of the repository, or which download to get. **See the release** opens its page.
- **Not now** hides the button, in that browser, until the next version.
- **Prereleases**, such as betas, are only mentioned if *Tell me about betas and other prereleases too* is on in Settings → Help. Someone already running a prerelease always hears of newer ones.

## Save and close

The box button in the header saves every open session and closes it, so you can stop for the day, restart the computer or switch to other work, and later pick them all up again:

- **Save and close all** lists the Claude and Codex sessions open in terminals and asks first. Any still working are listed apart, with a choice: wait for them to finish their turn and then close them, or close them now, which loses their current turn. A card waiting to close says *Closes when done*; clicking that keeps it open.
- Closing a session closes its terminal tab too. On Windows the session ends, then `exit` is typed into the tab's shell, so Windows Terminal closes the tab as it would if you'd typed it. Launchers in between, such as npm's wrappers and mise's or nvm's shims, end with it. On macOS and Linux the shell is hung up, and the terminal closes the tab or pane if its settings say to.
- **Resume last session** opens each saved session again, one tab each, running `claude --resume <id>` or `codex resume <id>` in its folder, so each conversation carries on. Sessions already open, or whose folder has gone, are skipped.

Only the last saved set is kept, in `~/.tabherd/saved-sessions.json`; the next Save and close replaces it. A session never asked anything has no conversation to resume, and one marked complete is done, so they're closed but not saved. Sessions in a VS Code panel, background runs, and other apps' jobs and models are left alone. A Codex session's turn is interrupted before its window closes; one whose window isn't known is saved but stays open.

## Complete

**Complete**, beside **Stop…** on a session's card, is for a session whose work is done. After a second click it closes the session and its tab, as Save and close does, and History marks it *Completed*, so it's told apart from work that was only closed. A session that's working finishes its turn first; until then its card says *Completes when done*, and clicking that keeps it open and takes the mark off.

A completed session can still be resumed from History. It stays complete if you only look, and stops being complete once you ask it something new. Save and close doesn't save a completed session, so Resume last session doesn't bring it back. Sessions marked complete are kept in `~/.tabherd/completed.json`.

## Tickets

Once [Settings → Tickets](#settings) has a tracker, each session's card shows the tickets it's working on, as chips under its folder. Each shows the ticket's key and status, with a dot for whether it's to do, in progress, done, or closed without being done. Hover for its title, assignee and tracker; click to open it.

A ticket is only linked if its tracker has it. A session's tickets come from:

- **Its branch:** a key anywhere in the branch's name, in any case, as in `abc-123-fix-login` or Linear's `eng-42-…`. A branch named for a GitHub issue, such as `123-fix-login`, links that issue in the GitHub repository the folder was cloned from.
- **Claim: lines:** a line starting with `Claim:` in a prompt you send, or in the session's reply.
  - `Claim: ABC-123`, or several, separated by commas.
  - `Claim: Linear ENG-42`, to say which tracker, by its type or name.
  - `Claim: octo/app#12`, or `Claim: #12` for the session's own repository.
  - `Claim: Zendesk 4567`, or a link.
  - `Unclaim: ABC-123` takes one off.

  A key mentioned in passing isn't linked. A session that creates an issue can claim it in its reply, so it's linked once it exists.
- **Links in prompts:** a link you send to a Jira issue, a Linear issue, a GitHub issue or a Zendesk ticket.
- **+ Ticket:** paste a link or key, as in a Claim: line. It says which it couldn't find.
- **Its to-do:** a to-do's *Tickets* field, which its session starts with. Pasting a ticket's link or key as a new to-do's title fills the to-do in from it; see [To-dos](#to-dos).

A key is looked up in every tracker it could be in, unless the tracker is named. With key prefixes in Settings → Tickets, a Jira or Linear tracker is only asked about keys with those prefixes. ✕ on a chip takes it off that session's card for good, and + Ticket links it again. History keeps each closed session's tickets as they were, and its filter finds sessions by a ticket's key or title.

A ticket's status is read again every five minutes while its card is shown, and one that wasn't found is asked about again after an hour. A tracker that refuses its sign-in or can't be reached says so in Settings → Tickets, and its tickets keep their last known status. Only a ticket's key goes to its tracker: a link in a session is read for its key, never fetched. What each session claimed is kept in `~/.tabherd/tickets.json`, with each ticket's last status.

**Complete** on a card with tickets opens a dialog in place of its second click, to update them before the session closes. Nothing is posted unless it's ticked, and your ticks are remembered for each tracker, in this browser. For each ticket:

- **Comment** posts a comment. It's filled in with the session that did the work, its recap or last reply, and its pull requests, and can be changed first. Jira gets it as a document, with its links as links. A Zendesk comment is an internal note unless *Public reply* is ticked, as a public reply emails the requester.
- **Move to done** moves the ticket to done:
  - **Jira:** a transition from its status into a done one, chosen if there's more than one.
  - **Linear:** its team's completed state.
  - **GitHub:** the issue is closed as completed.
  - **Zendesk:** the ticket is solved, which emails the requester.

  A ticket that's already done, or a pull request, isn't moved.

**Complete** posts what's ticked, then closes the session. If something fails, the dialog stays open and says why; what was already posted isn't posted again, and **Complete anyway** closes the session without the rest. Writing needs a token that can write: for a Jira scoped token, `write:jira-work`.

## History

The clock button in the header lists sessions that have closed, newest first and grouped by day. Each entry has the session's name, folder, branch and last prompt, and a filter searches all of those. **Resume** opens Claude in the session's folder, in your terminal, running `claude --resume <id>`, so the conversation carries on where it stopped. **Copy resume command** copies a command that does the same, for running yourself.

The server records a session when it drops off the dashboard, keeping its terminal tab's title and session name. Sessions that closed while the server wasn't running, or while no dashboard was open, are read from their transcripts in `~/.claude/projects`, going back 30 days. Those show Claude's title for the session, or its first prompt, rather than the tab's title. Each transcript is read once and again only if it changes, so after the first scan (about a second for 300 MB of transcripts) opening History is quick. Closed Codex sessions are read back the same way from `~/.codex/sessions`, named as Codex named them, apart from those Codex has compressed after a week. Sessions from a terminal are listed, and `claude -p` runs, tagged **Background** (see [Background runs](#background-runs)); `codex exec` and Agent SDK runs aren't. Nor are sessions closed before Claude was asked anything: Claude saves no conversation for those, so there's nothing to resume. A session that's running again, because it was resumed, leaves the list until it closes. Sessions marked [complete](#complete) say *Completed*, and the header counts them; *Complete sessions* under the filter hides them, to leave the work you might come back to. The history keeps the latest 300 sessions, in `~/.tabherd/history.json`.

## Repo menu

The ☰ button at the top left lists the git repos under `~/source` (set `REPOS_DIR` to change it) as a folder tree, e.g. work → acme → api. Any folder with a `.git` entry counts, worktrees included. Each folder shows how many repos it holds, and a green dot marks repos that already have a Claude session running. Folders hidden in Settings, and everything inside them, are left out, and the menu's heading says how many are hidden. Folders you open stay open next time. Typing in the filter keeps repos whose path contains every word and whose name contains at least one. Enter opens the repo when only one matches. `http://localhost:4317/#repos/<filter>` opens the menu already filtered.

Clicking a repo opens Claude there, in your terminal. On macOS and Linux the new tab runs `cd <repo> && claude` in your login shell, which stays open after Claude exits. On Windows it's a tab in your most recent Windows Terminal window:

```
wt -w 0 new-tab -p <your default profile> -d <repo> pwsh -NoExit -EncodedCommand <claude>
```

With *Skip permission prompts* on in Settings, the command is `claude --dangerously-skip-permissions`. Claude runs inside pwsh, so when you quit Claude the tab stays open at a prompt in the repo. The server only opens folders from its own scan, from the folder picker for a to-do, or for Resume from its own history, never a path sent by the page.

The tab uses your default Windows Terminal profile on purpose. If `profiles.defaults` sets `"elevate": true` and a tab is opened with just a command line, the tab gets that default. Windows Terminal then opens it in a separate administrator instance and mangles the command on the way. Naming the default profile gives the tab the same settings as a new tab you open yourself. The command is base64-encoded so Windows Terminal can't split it or read its flags as its own.

## Terminal titles

Each card is headed with what the session's terminal tab shows. For a tab you haven't renamed, that's the session's own title without the spinner glyph. For a renamed tab ("API - auth"), it's your name for the tab. Titles are read every few seconds while the dashboard is open: on Windows by a background PowerShell worker (`lib/terminals/windows-titles.ps1`), on macOS and Linux from the terminal or tmux.

In Windows Terminal, a renamed tab hides the session's title, so it only reveals which session it holds while it's the selected tab. The dashboard learns each one when you view that tab or use Go to window, or by elimination once it's the only unmatched tab in its window. Until then the card shows Claude's title. It never switches tabs to find out. The Claude session name (e.g. `api-server-3d`) moves to the line with the PID.

## Go to window

On macOS and Linux, the session's terminal device and its parent processes show which terminal it runs in, or that it's inside tmux, and that terminal's scripting selects the tab (`lib/terminals/`). In tmux, tmux selects the pane, and the terminal showing tmux comes forward.

On Windows, `lib/terminals/windows-focus.ps1` attaches to the session's console. The owner of the console window shows which Windows Terminal window hosts it, and the console title is the session's title. UI Automation then finds the tab whose name matches. A tab you renamed hides the session's title, so for those it steps through the window's tabs until a pane shows that title, then focuses the pane. For other hosts, such as VS Code or a classic console, it brings up the hosting app's window.

Run `powershell -File lib/terminals/windows-focus.ps1 -TargetPid <pid> -DryRun` to see how a session would be found without switching anything.

Start the server from a normal terminal. If it's started from a sandboxed shell, such as Claude Code's Bash sandbox, the system may block it from switching other windows.

## Where the data comes from

All of it is read-only, from files Claude Code and Codex already write, and from Codex's, ComfyUI's and LocalAI's own services:

| Source | Used for |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | The list of sessions, with their status, name, folder and version. The `.key` files next to them are never read. |
| `~/.claude/projects/<project>/<session>.jsonl` | Title, prompts, tool calls, model, token usage, recaps and PR links. Each poll reads only the newly appended bytes. |
| `…/<session>/subagents/*.meta.json` and `*.jsonl` | Subagents and what they are doing. |
| `Get-Process` (Windows) or `ps` | Memory use, and a check that each PID still belongs to the Claude process that registered it. |
| Codex's background service, through `codex app-server proxy` | Which Codex sessions are open, their names and their status. |
| `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session>.jsonl` | A Codex session's prompts, replies, tool calls, model and token usage. |
| `~/.codex/session_index.jsonl` | Closed Codex sessions' names, for History. |
| The `codex` processes and their tab titles | Which window each Codex session is in, and its memory use. |
| OpenCode's background service: `/api/session`, `/api/session/active`, and each shown session's permission requests, questions and messages | Which OpenCode sessions are open, their status, titles, prompts and replies. |
| The `opencode` processes and their tab titles | Which window each OpenCode session is in, and its memory use. |
| `~/.cursor/chats/<folder hash>/<chat>/meta.json` | Each Cursor chat's folder and title, and when it began and changed. |
| `~/.cursor/projects/<folder>/agent-transcripts/<chat>/<chat>.jsonl` | A Cursor chat's prompts, replies and tool calls, and where each turn ended. |
| The `cursor-agent` processes and their tab titles | Which window each Cursor chat is in, its state with Cursor's status indicators on, its version and memory use. |
| Comfy Desktop's `comfy-procs/*.json` and `installations.json` | Which ComfyUIs are running, on which ports, and their names. |
| ComfyUI's `/api/jobs`, `/queue`, `/api/userdata` and `/view` | Its jobs, their workflows' names and the models they load, and their output images. Its window's title gives the running job's progress. |
| LocalAI's `/system`, `/api/operations`, `/api/chats` and `/api/agent/jobs` | Its loaded models and which are working, downloads, agent chats and agent jobs. |
| Each session folder's `.git`: its `HEAD` and `origin` | The branch's tickets, and the GitHub repository a `#12` is in. |
| The trackers in Settings → Tickets, and `gh api repos/<owner>/<repo>/issues/<n>` | Each linked ticket's title, status and assignee. Only the ticket's key or number is sent. |
| GitHub's list of Tabherd's releases (`api.github.com/repos/tleeadams/tabherd/releases`) | Whether a newer version is out. Only with [update alerts](#update-alerts) on, or after **Check now**. |

A session file whose process has exited, or whose PID now belongs to another process, is ignored.

The only files the server writes are its own, in `~/.tabherd`: `settings.json` holds the settings that aren't kept in the browser, with its secrets encrypted (see [Secrets](#secrets)), `secret.key` the key for them on Windows, `history.json` the closed sessions, `todos.json` the to-dos, `groups.json` the groups, with the sessions moved between them by hand, `saved-sessions.json` the sessions Save and close saved last, `completed.json` the sessions marked complete, `tickets.json` the tickets sessions claimed and the last status of each, and `updates.json` what the last check for a new version found.

## Safety

The server listens on `127.0.0.1` only and rejects requests with any other `Host` header, so other web pages can't read your prompts through DNS rebinding. The session actions, opening a repo, resuming a closed session, the to-do actions and saving settings all need a per-run token that only the served page has. A to-do's title reaches the folder picker only as an environment variable, never as part of a command. The session actions also work only on a session that is currently verified as live. **Stop** ends the session and its child processes, after you confirm: `taskkill /T /F` on Windows; on macOS and Linux, SIGTERM and then SIGKILL two seconds later for any still running. For a Codex session, it first interrupts the session's turn through Codex's service. Sessions the dashboard opens ask before acting, as Claude Code does by default, unless you turn on *Skip permission prompts*.

### Secrets

Tokens, API keys and the ticket trackers are saved encrypted in `settings.json`, as `enc:v1:…` values (AES-256-GCM). That includes the trackers' addresses and emails, and LocalAI's key and LM Studio's token. The key is 32 random bytes that the operating system keeps for you:
- **Windows:** protected with DPAPI for your user, in `~/.tabherd/secret.key`. Only you, on this computer, can unlock it.
- **macOS:** your login Keychain, as *Tabherd settings key*.
- **Linux:** your keyring (GNOME Keyring or KWallet), through `secret-tool`. Without one, the key is kept in `~/.tabherd/secret.key`, readable only by you, and Settings → Tickets says so.

The key is made the first time a secret is saved, and keys saved by older versions are encrypted when the server next starts. A `settings.json` copied to another computer or user can't be decrypted there, so its secrets count as unset and Settings asks for them again. A secret is never sent to the page, which only learns whether one is set.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Development

```
npm run setup      # once after cloning: turn on the git hooks for the branch rules
npm test           # the tests, with Node's built-in test runner
npm run build      # build the release zip for this platform into dist/
npm run check-terminals   # check driving each terminal here, with a stand-in session
npm run icons      # make the icons in public/icons from assets/logo.png, after changing it
```

There are no dependencies to install. CI runs the tests on Windows, macOS and Linux, with Node 18 and 24, and builds the Windows zip, on every pull request and every push to `main` and `develop`. [NOTES.md](NOTES.md) has working notes: what's planned, what isn't confirmed yet, and the Windows quirks found along the way.

The repository follows gitflow: work happens on `feature/` branches off `develop`, and `main` only takes releases. [CONTRIBUTING.md](CONTRIBUTING.md) has the branch rules, how they're enforced, and the steps for a release. Releases bundle the Node version in `.node-version`.

To add a platform to the releases, give `scripts/build-release.js` a target for it and add its runner to `.github/workflows/release.yml`.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Only the Windows app, `Tabherd.exe`, and its installer are signed. The [Release workflow](.github/workflows/release.yml) builds them on GitHub from the tagged source, and SignPath signs each only after an approver approves it for that release: the app first, then the installer built around the signed app. The bundled `node.exe` keeps the Node.js project's own signature.

- Committers and reviewers: the people in [`.github/CODEOWNERS`](.github/CODEOWNERS)
- Approvers: [@tleeadams](https://github.com/tleeadams)

Privacy: this program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. [Update alerts](#update-alerts), which ask GitHub for Tabherd's latest release, are off until you turn them on.

## License

Tabherd is free software under the [GNU General Public License, version 3](LICENSE) or later. Releases include Node.js, which has its own licence: in `node/LICENSE`, or `node-LICENSE` beside the Windows app.
