# Security

Tabherd reads your coding agents' prompts and transcripts and can open terminals and stop processes, so security problems matter. Please report them privately, through this repository's **Security** tab ("Report a vulnerability"), rather than in a public issue.

## What the dashboard does to stay safe

- The server listens on `127.0.0.1` only, and rejects requests whose `Host` header isn't `localhost` or `127.0.0.1` on its port. That stops other web pages reaching it through DNS rebinding.
- Every action that changes something (going to a window, Catch up, Stop, opening a repo, Resume, to-dos and settings) needs a token that's made fresh each time the server starts and is only in the page the server serves.
- Commands are always built by the server. The page never sends a command or a folder to run one in: folders come from the server's repo scan, its history, or Windows' folder picker.
- Sessions the dashboard opens run plain `claude`, which asks before editing files or running commands, unless you turn on *Skip permission prompts* in Settings.
- It reads Claude Code's files without changing them, and never reads the `.key` files in `~/.claude/sessions`. Its own files are in `~/.tabherd`.

The release download isn't code-signed yet. Each release has a SHA-256 checksum beside the zip on the release page.
