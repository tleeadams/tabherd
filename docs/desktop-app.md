# Desktop app (Tauri)

*Spec, 2026-11-24. Phase 1, Windows, is built; see [Progress](#progress).*

Tabherd gets a window of its own, so it no longer runs inside a browser. The server and the page stay as they are. A small Tauri app takes the launchers' place: it starts the server, shows the page in the system's web view, and stops the server again when it quits.

## Why

Today the Windows launcher opens the dashboard as an Edge app window (`msedge.exe --app=…`). On macOS and Linux, `tabherd` opens a Chromium app window if Chrome, Edge, Brave, Chromium or Vivaldi is installed, and the default browser if not. That window shares the browser's profile, so:

- Edge's downloads button appears in Tabherd's title bar whenever the browser is downloading something. Extensions run in it too.
- Sound is blocked until the page is clicked, after every load.
- The settings kept in browser storage belong to that browser profile.
- On macOS and Linux, getting a window without tabs depends on which browser is installed.

## Choice of framework

| | Server runs on | Page shown in | Linux | Download |
|---|---|---|---|---|
| **Tauri 2** (chosen) | The bundled Node, as a sidecar | WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux | Yes | Shell ~5–10 MB, plus Node (~30 MB, shipped today anyway) |
| Electron | Electron's own Node | Bundled Chromium | Yes | ~100 MB |
| Electrobun | Bun | System web view | Yes | ~14 MB |
| .NET MAUI | The bundled Node | Web view control | No official support | Large |
| WebView2 in the C# launcher | The bundled Node | WebView2 | Windows only | ~1 MB of Microsoft libraries |

Tauri is chosen because:

- **Neither the server nor the page needs rewriting.** The server is already a local web server. Tauri's documented pattern is a window that loads it, with Node running beside the app as a sidecar. Releases already bundle Node.
- **It's light for something that stays open all day.** It uses the system's web view, not a bundled Chromium. On Windows that's WebView2, the Edge engine, so the page renders as it does now, and Windows keeps it updated.
- **It covers all three systems,** with plugins for running a single instance, opening links, notifications, a tray icon and starting at login.

Electron is the easier port, but it's about three times today's download, uses the most memory, and needs a new release for each Chromium security fix. MAUI has no official Linux support. Electrobun would move the server from Node to Bun on a young framework. WebView2 in the launcher only fixes Windows.

## What stays the same

- `server.js`, `lib/` and `public/` are unchanged for the first release. The page is still served from `http://localhost:4317` (or `PORT`) and loaded from there.
- Data stays in `~/.tabherd`.
- Node is still bundled, at the version in `.node-version`, downloaded and checked against nodejs.org's checksums as `scripts/build-release.js` does now.
- Running from source stays as it is: `node server.js`, then a browser.

## How it works

```
Tabherd (Tauri, Rust)
 ├─ On start: is a Tabherd server answering on the port?
 │    yes → use it (one started from source, or by an earlier copy of the app)
 │    no  → start the sidecar: node server.js --exit-when-idle, with PORT set,
 │          and wait until it answers (as the launchers do now)
 ├─ One window, loading http://localhost:<port>/, remembering its size and place
 ├─ Links that would open a new window (target="_blank", window.open) open in
 │  the default browser instead
 ├─ A second launch brings the open window forward (single-instance plugin)
 └─ On quit: stops the server it started, never one it found running
```

- **One Tauri call from the page.** The page is a remote URL as far as Tauri is concerned, so it gets no access to Tauri's APIs, except `set_on_top`, the app's one command. `capabilities/dashboard.json` allows it for `http://localhost:*` alone, and `build.rs` declares it, which makes Tauri check every app command against the capabilities. The app hands the page `window.tabherdApp` in an initialization script: `setOnTop(on)`, and `seeThrough`, whether the window can be see-through. Everything else the app does happens in Rust.
- **`--exit-when-idle` stays** as a safety net. If the app is killed without stopping its server, the server still stops itself 10 minutes after the last dashboard closes.
- **Closing the window quits the app** in the first release, as closing the Edge window does now. A tray icon that keeps it running comes later (see [Later](#later)).

### Repository layout

```
app/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    build.rs
    capabilities/dashboard.json  the one command the page may call
    icons/                      from the existing app icon
    src/main.rs                 server start and stop, window, link handling
    binaries/                   staged by the build, not committed:
      node-x86_64-pc-windows-msvc.exe, node-aarch64-apple-darwin, …
```

The server's files go in as bundle resources: the same list `build-release.js` ships today (`server.js`, `package.json`, `lib`, `public` and the licence files). Node goes in as the sidecar (`bundle.externalBin`). Tauri wants each sidecar named with its target triple, so the build script stages `node` under that name before `tauri build`.

### The window

- **Title.** It follows the page's title, which counts the sessions waiting on you ("(2) Tabherd"). *To check:* whether Tauri 2 passes on document-title changes for a remote URL. If it doesn't, the page needs one small call, and that adds an IPC permission for localhost.
- **Sound without a click.**
  - Windows: WebView2 is started with `--autoplay-policy=no-user-gesture-required`.
  - macOS and Linux: *to check* whether Web Audio still needs a click in WKWebView and WebKitGTK.
- **On top.** Settings → Appearance → Window → *Keep on top*, or the pin in the header, which only show in the app, keep the window above other windows. The page calls `set_on_top`, which calls Tauri's `set_always_on_top`. It's kept in the page's storage and set again as the page loads, so the window isn't on top for the moment before that.
- **Transparency.** On Windows the window is created transparent, and the page's backgrounds decide how much shows through: opaque, unless Settings → Appearance → Window → *Transparency* says otherwise (up to 80%). The page and the header let that much through, and the cards a little less. Text, buttons and dialogs stay solid. macOS would need Apple's private API (`macOSPrivateApi`) for a transparent window, and Linux hasn't been tried, so neither offers it.
- **Browser storage.** The web view keeps its own, in the app's data folder. The settings kept in the browser (Appearance, Notifications, Sections by group, the chosen filter) start fresh once. The first-run tour shows once too, since the new window counts as a new browser.
- **Developer tools** are in debug builds only. On Windows, a debug build also turns on WebView2's remote debugging port, so the headless checks in `dist/e2e` can run against the app.

## Packaging and signing

### Windows

- Built on `windows-latest`.
- **Installer:** NSIS, installing for the current user without administrator rights. It adds a Start menu shortcut, with a Desktop one as an option. WebView2 comes with Windows 11 and up-to-date Windows 10. For a computer without it, the installer downloads Microsoft's bootstrapper (`webviewInstallMode: downloadBootstrapper`).
- **Portable zip:** the app, Node and the server files, for anyone who doesn't want an installer (*decision 1*).
- **Signing, through SignPath as now,** in two stages, because the installer has to contain the signed app:
  1. `tauri build --no-bundle` builds `Tabherd.exe`, and SignPath signs it.
  2. `tauri bundle` builds the installer around the signed exe, and SignPath signs the installer.

  That's two signing requests, so two approvals per release. The SignPath artifact configuration (`.signpath/artifact-configuration.xml`) changes to cover both files, and the code signing policy in the README is updated to match. `node.exe` keeps the Node.js project's own signature.
- **What it replaces:** the C# launcher (`launcher/Tabherd.cs`, `scripts/launcher.js`) and the *Install shortcuts* and *Remove shortcuts* scripts. They stay in the repository until the app has shipped in one release.
- **winget:** the manifest's installer type changes from zip to `nullsoft`, starting with the first submission after the app ships.

### macOS

- Built on `macos-latest`, once each for arm64 and x64, as now. A single universal build would need a universal Node, which Node doesn't publish.
- **Output:** `Tabherd.app` in a `.dmg`.
- **Signing and notarization** happen in the release workflow; see [Apple signing](#apple-signing-automatic-on-release).
- **Entitlements under the hardened runtime,** which notarization requires:
  - `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`, for V8 in the Node sidecar.
  - `com.apple.security.automation.apple-events`, with an `NSAppleEventsUsageDescription` in `Info.plist`. Tabherd drives Terminal, iTerm2 and Ghostty with `osascript`. Without this entitlement, the hardened runtime blocks it.
- macOS's Automation prompt then names Tabherd, not the browser or terminal it was started from.
- **Homebrew:** the tap gets a cask for the signed `.dmg`. The formula stays for anyone who wants `tabherd` with a browser window (*decision 3*).

### Linux

- Built on `ubuntu-22.04` (x64) and `ubuntu-22.04-arm` (arm64). The older glibc there means the build runs on more distributions.
- **Output:** `.deb`, `.rpm` and AppImage. They need WebKitGTK 4.1.
- No signing.

### Apple signing, automatic on release

Each release tag signs and notarizes the macOS app with no manual steps, once the secrets below exist. The keys never go into the repository or a chat: the owner adds them as GitHub secrets.

**Prerequisites**

- **Apple Developer Program membership** ($99 a year).
- **A Developer ID Application certificate.** Only the Account Holder can create one. Export it from Keychain Access as a `.p12`, with a password.
- **An App Store Connect API key,** for notarization: in App Store Connect, under Users and Access → Integrations → Team Keys, make a key with the Developer role. That gives a `.p8` file, its key ID and the issuer ID.

**Secrets**

Put these in a `release` environment that only `v*` tags can use. The names are the ones Tauri's bundler reads.

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | The `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | Its password |
| `APPLE_API_ISSUER` | The issuer ID |
| `APPLE_API_KEY` | The key ID |
| `APPLE_API_PRIVATE_KEY` | The `.p8` file's contents. The workflow writes them to a temporary file and points `APPLE_API_KEY_PATH` at it. |

From the owner's own terminal, for example:

```
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --env release
gh secret set APPLE_CERTIFICATE_PASSWORD --env release
gh secret set APPLE_API_ISSUER --env release
gh secret set APPLE_API_KEY --env release
gh secret set APPLE_API_PRIVATE_KEY --env release < AuthKey_XXXXXXXXXX.p8
```

**In the workflow**

- Tauri imports the certificate into a temporary keychain. It signs the app and the Node sidecar with the hardened runtime and the entitlements above, sends the app to Apple for notarization, and staples the ticket.
- The job then checks the result with `codesign --verify --deep --strict`, `spctl --assess` and `xcrun stapler validate`. It fails rather than release an app that doesn't pass, as the Windows job does with SignPath's signature.
- **The switch:** a variable, `APPLE_SIGNING`, turns this on, as `SIGNPATH_ORGANIZATION_ID` does for Windows. Until it's set, the macOS app is left out of releases and the current `tar.gz` ships instead (*decision 4*). An unsigned app downloaded from GitHub is blocked by Gatekeeper.

## Testing

- `npm test` is unchanged. Rust gets `cargo clippy` and tests for the small helpers: the port check and finding the resources.
- **Windows:** a debug build with WebView2's debugging port, driven by the `dist/e2e` scripts.
- **macOS and Linux:** by hand for the first release. Later, WebDriver tests through `tauri-driver` on Linux.
- **Checks before the first release:**
  - A first launch starts the server; a second launch brings the window forward.
  - A server that's already running is used, and quitting leaves it running.
  - Quitting stops the server the app started.
  - PR links and *Open in LocalAI* open in the default browser.
  - Ctrl+R reloads, and *Copy resume command* copies.
  - Sound plays without a click, where the platform allows it.
  - The update stream reconnects after the computer sleeps.
  - The window's title shows the count of sessions waiting on you.
  - Go to window, Catch up, the folder picker and the repo menu still bring their windows to the front, now that Tabherd (not Edge) is the app in front.
  - On macOS, the Automation prompt names Tabherd, and the terminal drivers work under the hardened runtime.
  - The page renders correctly in WKWebView and WebKitGTK: popovers, dialogs, `:has()`, `light-dark()` and `@starting-style`. These set the oldest macOS and Linux versions the app supports.

## Phases

1. **Windows.** The app, the sidecar, the window, single instance, opening links, the title and sound. Release workflow with SignPath in two stages, the installer and the zip. The launcher retired after this ships.
2. **macOS.** Entitlements, Apple Events, signing and notarization from secrets, the `.dmg` and the Homebrew cask.
3. **Linux.** `.deb`, `.rpm` and AppImage, checked on Ubuntu 24.04.

## Later

- A tray icon showing how many sessions need you, with closing to the tray so dings carry on.
- Native notifications naming the session, alongside the dings.
- Starting at login.
- A count on the taskbar or dock icon.
- Updates through Tauri's updater. It has its own signing key, separate from Apple's and SignPath's.
- Moving the settings now kept in the browser to the server, so they don't reset when the window changes.

## Decisions for the owner

1. **Windows:** installer only, or installer and portable zip? *Suggested:* both for the first release, with winget pointing at the installer.
2. **The close button:** quit, as now, or close to the tray? *Suggested:* quit for the first release, and the tray later.
3. **Homebrew:** a cask for the app and the formula kept for `tabherd` with a browser window, or the cask only? *Suggested:* both.
4. **Until Apple signing is set up:** leave the macOS app out and keep the `tar.gz`? *Suggested:* yes.
5. **The version** the app first ships in.

## To check first

A short spike on Windows, before the rest:

- Whether the window's title can follow the page's title for a remote URL.
- Sound without a click, in each web view.
- Bringing other windows forward (Go to window, the folder picker) when Tabherd is the app in front.
- Which WebKit versions render the page correctly, which sets the oldest supported macOS and Linux.
- Notarizing a bundle that contains Node with the JIT entitlements.

## Progress

**2026-11-24: phase 1, Windows, built** on Tauri 2.12 with tauri-cli 2.12, the decisions taken as suggested.

- **The spike's answers on Windows:**
  - The title follows the page through `on_document_title_changed`, with no IPC.
  - WebView2 plays sound with no click, given `--autoplay-policy=no-user-gesture-required`.
  - New-window links go to the browser through `on_new_window`.
  - Checked with a debug build driven over WebView2's DevTools port (9223 in debug builds).
- **Release builds:** the app is 3.2 MB, the installer 23.8 MB and the zip 35.1 MB (Node is most of both).
  - The installer, installed silently, ran its own Node from `%LOCALAPPDATA%\Tabherd`. Quitting stopped it, and the uninstaller left no files or uninstall entry. The app's own data stays in `%LOCALAPPDATA%\io.github.tleeadams.tabherd` and `%APPDATA%\io.github.tleeadams.tabherd`.
  - The zip, unpacked, did the same.
- **Signing in two stages works,** with one catch. `tauri bundle` normally writes the package type into the app (for Tauri's updater), which would break a signature applied before packaging. `--no-binary-patching` stops that: the app's bytes are unchanged by packaging, and the installer holds the identical file.
- **Building on Windows needs Rust's MSVC toolchain.** A machine whose default is the GNU one can add MSVC alongside and use `RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc`.
- **Checked by hand on Windows** (the owner, 2026-11-24): Go to window, Catch up and the folder picker bring their windows forward with Tabherd in front, and PR links open in the browser.
- **Still to check:** the first signed release.
- **Phase 2, macOS, is ready for its keys** (2026-11-24). `build-release.js --target macos-<arch> --app` builds the disk image; the Release workflow's `build-macos` job runs it for Apple silicon and Intel once `APPLE_SIGNING` is on, then checks the signature, Gatekeeper and the stapled ticket. CI builds the same image unsigned on every change. CONTRIBUTING has the setup. Still to see: the first signed, notarized build, and the app on a Mac.
