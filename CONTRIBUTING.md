# Contributing

## Branches

The repository follows gitflow:

| Branch | Comes from | Merges into | For |
| --- | --- | --- | --- |
| `main` | | | Releases only. Every commit on it is a merged release or hotfix, tagged `v<version>`. |
| `develop` | `main` | | Where work comes together. Pull requests target it by default. |
| `feature/<name>` | `develop` | `develop` | New work. Lowercase, with dashes: `feature/todo-cards`. |
| `bugfix/<name>` | `develop` | `develop` | Fixes to unreleased work. |
| `release/<version>` | `develop` | `main`, then `develop` | Getting a release ready: `release/0.2.0`. |
| `hotfix/<version>` | `main` | `main`, then `develop` | Urgent fixes to a release: `hotfix/0.2.1`. |

`main` and `develop` only change through pull requests, which merge with a merge commit. That keeps each branch's history and makes merging a release back into `develop` clean.

### What enforces it

- **On GitHub:** rulesets (`.github/rulesets`) stop direct pushes, force-pushes and deletion on `main` and `develop`. Before a pull request merges, the CI and Gitflow checks have to pass, and someone in `.github/CODEOWNERS` has to approve it (see [Reviews](#reviews)). The admin can skip waiting for CI and the review (see [The admin's fast path](#the-admins-fast-path)). The Gitflow check (`.github/workflows/gitflow.yml`) refuses a pull request from the wrong kind of branch. A pull request from a release or hotfix into `main` also has to set that version in `package.json` and have a section for it in `CHANGELOG.md`. Release tags can't be moved or deleted, and the release workflow only builds tags that are on `main`.
- **On your computer:** git hooks catch the same mistakes before you push. Turn them on once after cloning:

  ```
  npm run setup
  ```

  They stop commits made directly on `main` or `develop`, commits on branches named outside the model, and pushes to `main` or `develop` once those exist. Merging into `develop` or `main` locally is allowed, but the result reaches GitHub through a pull request. The rules live in `scripts/gitflow.js`; `node scripts/gitflow.js check-branch <name>` checks a name.

## Reviews

A pull request into `main` or `develop` needs an approving review from someone listed in [`.github/CODEOWNERS`](.github/CODEOWNERS). Anyone can comment on a pull request, but only those reviewers' approvals count.

- An approval only counts for what it saw. A new push dismisses it, and the latest push has to be approved by someone other than whoever made it.
- Every review conversation has to be resolved before merging.
- The repository's admin can merge a pull request without waiting for a review or for CI. See [The admin's fast path](#the-admins-fast-path).

To let someone review, the admin:

1. Gives them write access: Settings → Collaborators, or `gh api -X PUT repos/<owner>/<repo>/collaborators/<their-handle> -f permission=push`. GitHub ignores reviewers without it.
2. Adds their handle to `.github/CODEOWNERS`, in a pull request like any other change. Changing that file needs an approval from someone already in it, so only existing reviewers can add new ones.

Write access also lets them push branches. `main` and `develop` still only change through pull requests.

### The admin's fast path

The repository's admin can merge a pull request into `main` or `develop` straight away, without waiting for a review or for CI: tick **Merge without waiting for requirements to be met** when merging, or run `gh pr merge --merge --admin`. That's how an urgent hotfix goes out in about half a minute. It's also how the admin merges their own work while they're the only reviewer, since GitHub never lets authors approve their own pull requests.

It's a choice made at each merge, not a different way of working. Open the pull request and request reviews as usual. Leave the box unticked to wait for the reviews and CI, as anyone else would.

What the fast path never skips:
- The change still arrives as a pull request from the right kind of branch, with a merge commit. Direct pushes to `main` and `develop` stay blocked, for the admin too.
- The Gitflow check still has to pass, so a hotfix sets its version and changelog. It takes about half a minute.
- CI still runs on the pull request, and on `main` after the merge. The release workflow runs the tests before it builds, so a hotfix that breaks them doesn't become a release.

Only the "CI" and "Reviews" rulesets can be bypassed, and only by the admin, only while merging a pull request. People given write access to review can't bypass anything. For the admin's own pull requests to wait for a review as well, remove `bypass_actors` from `.github/rulesets/reviews.json` and run `npm run setup-github` again, once someone else can review.

### A check that failed elsewhere

GitHub attaches check results to commits, not to pull requests. If two pull requests share a commit and one fails the Gitflow check, every pull request on that commit is blocked. That happens when a branch is opened against the wrong base and then the right one. Closing the wrong pull request doesn't clear it, and neither does re-running the right one's check. Either push a new commit to the branch, or delete the failed run: find it with `gh run list --workflow Gitflow` and remove it with `gh run delete <id>`.

## Making a change

```
git switch develop && git pull
git switch -c feature/<name>
# work, commit, npm test
git push -u origin feature/<name>
```

Then open a pull request into `develop` and ask for a review.

Keep examples, tests and docs free of real names. Use made-up projects, folders and people (`work/acme/api`, "API - auth") rather than ones from your own computer or work.

### Languages

The page is written in English and shown in the language chosen in Settings. Each other language has a table in `public/lang/<code>.js`, from the English as the page has it to that language.

- In `public/app.js`, every text the page shows goes through `tr()`, with `{name}` for what's filled in: `tr('Moved to {group}', { group: g.name })`. A count goes through `trn()`, with the English for one and for more: `trn(n, '{n} prompt', '{n} prompts')`. Keep each sentence whole in one text, so a language can put its words in its own order.
- Text in `public/index.html` is translated as the page loads, piece by piece. Where words run either side of a `<b>` or `<code>`, mark the element `data-i18n` so it's translated whole, markup and all.
- Add the Spanish for each new text to `public/lang/es.js`. `npm test` lists any the page uses that the table doesn't have, any the table has that nothing uses, and any whose `{name}` parts or markup don't match.
- A new language: a table like `es.js`, its name in `LANGUAGES` in `app.js`, a `<script>` for it in `index.html`, and its path in `STATIC` in `server.js`.

## Releasing

1. Start the release from `develop`: `git switch -c release/<version> develop`. Set the version in `package.json` and add a `## <version>` section to `CHANGELOG.md`; the release notes come from it. Commit, push, and open a pull request into `main`.
2. Merge it once the checks pass and it's been reviewed.
3. Tag the merge on `main`: `git switch main && git pull && git tag v<version> && git push origin v<version>`.
4. The Release workflow tests, builds the downloads and makes a draft release. Once signing is set up, it waits up to an hour each for two signing requests to be approved on [signpath.io](https://app.signpath.io): the Windows app's, then its installer's. An approver approves them there. Check the draft and publish it.
5. Open a pull request from `main` into `develop`, so `develop` has the release's changes.
6. Package managers:
   - **Homebrew** ([tleeadams/homebrew-tap](https://github.com/tleeadams/homebrew-tap)) picks the release up by itself within a day: its Update workflow installs and tests the formula at the new release on macOS and Linux, then commits it. Run that workflow from its Actions tab to do it now.
   - **winget**: submit the new version to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) as a pull request, with the three manifest files for `tleeadams.Tabherd` updated to the new version, URL and SHA-256 (`wingetcreate update tleeadams.Tabherd -v <version> -u <installer url> --submit` does it). Microsoft validates and merges it, typically within a few days. From the first release with the desktop app, the manifest should point at the installer (`-setup.exe`): installer type `nullsoft`, scope `user`, and `UpgradeBehavior: uninstallPrevious`, so that a copy installed from the portable zip is replaced rather than left beside it. The installer adds Tabherd to the Start menu, which a portable install doesn't. The zip still works as a portable install too (`zip`, nested `portable`, `tabherd-windows-x64Tabherd.exe`): the app follows winget's link back to its own folder to find Node and the server.

### Hotfixes

A hotfix starts from `main` and goes back into it:

```
git switch main && git pull
git switch -c hotfix/<version>
# fix it, set the version in package.json, add a "## <version>" section to CHANGELOG.md, commit
git push -u origin hotfix/<version>
gh pr create --base main --fill
gh pr merge --merge --admin      # the admin's fast path; otherwise wait for review and CI
git switch main && git pull && git tag v<version> && git push origin v<version>
gh pr create --base develop --head main --title "Bring v<version> into develop"
```

The tag starts the Release workflow, as for a release. The last pull request brings the fix into `develop`.

## Setting up the GitHub repository

For maintainers, once, after creating the repository on GitHub:

1. Push `main` and `develop`. The rulesets would stop pushes that create them, so they come first.
2. With the [GitHub CLI](https://cli.github.com) signed in as an admin of the repository, run `npm run setup-github`. It applies the rulesets in `.github/rulesets`, makes `develop` the default branch, allows only merge commits, deletes branches once merged, and turns on private vulnerability reporting. It also names anyone in `.github/CODEOWNERS` who doesn't have write access yet. Running it again updates the rulesets.

### Code signing

The Windows app and its installer are signed by [SignPath Foundation](https://signpath.org), which signs open-source projects for free, under the policy in the README. Until the project is set up there, releases ship unsigned. To set it up:

1. Apply at [signpath.org/apply](https://signpath.org/apply). Everyone on the team, on GitHub and on SignPath, needs two-factor sign-in.
2. Once approved, on [app.signpath.io](https://app.signpath.io): link the project to the predefined GitHub.com trusted build system, and paste `.signpath/artifact-configuration.xml` into its default artifact configuration, for the app (`Tabherd.exe`). Add `.signpath/installer-configuration.xml` as a second artifact configuration with the slug `installer`. Releases are built from version tags on `main`, so if the signing policy limits what can be signed by branch, allow the `v*` tags.
3. Make an API token for a user who can submit signing requests to the release signing policy.
4. In the repository's settings, under **Secrets and variables → Actions**, add the token as the secret `SIGNPATH_API_TOKEN` and the organization's ID as the variable `SIGNPATH_ORGANIZATION_ID`. If the project, signing policy or installer configuration aren't called `tabherd`, `release-signing` and `installer`, add `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG` or `SIGNPATH_INSTALLER_CONFIGURATION_SLUG` too.

The variable turns signing on. The app is signed first, and the installer is then built around the signed app and signed in a second request. Packaging is told not to touch the app (`--no-binary-patching`), which would break its signature. The workflow checks each signature, and fails rather than release a file that isn't validly signed.

### Apple signing

The macOS desktop app is signed with a Developer ID and notarized by Apple in the Release workflow, so a downloaded copy opens without Gatekeeper's warnings. Until it's set up, releases leave the app out and macOS ships the `tar.gz` archives. The keys go into GitHub as secrets, from your own computer, never into the repository or a chat. To set it up:

1. Join the [Apple Developer Program](https://developer.apple.com/programs/). Only the account holder can make the certificate.
2. Make a **Developer ID Application** certificate: on a Mac, in Xcode, **Settings → Accounts → Manage Certificates → + → Developer ID Application**. Then, in Keychain Access, under **My Certificates**, export it with its private key as a `.p12`, with a password.
3. Make an API key for notarizing: in [App Store Connect](https://appstoreconnect.apple.com), **Users and Access → Integrations → App Store Connect API → Team Keys**, add a key with the Developer role. Download its `.p8` (Apple only lets you do that once), and note its key ID and the issuer ID above the list.
4. Make a `release` environment that only version tags can use, and put the secrets in it:

   ```
   gh api -X PUT repos/tleeadams/tabherd/environments/release -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true"
   gh api -X POST repos/tleeadams/tabherd/environments/release/deployment-branch-policies -f name='v*' -f type=tag
   base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --env release
   gh secret set APPLE_CERTIFICATE_PASSWORD --env release
   gh secret set APPLE_API_KEY --env release              # the key ID
   gh secret set APPLE_API_ISSUER --env release           # the issuer ID
   gh secret set APPLE_API_PRIVATE_KEY --env release < AuthKey_<key ID>.p8
   ```

   Each `gh secret set` without a file asks for the value, so it isn't kept in your shell's history.
5. Turn it on: `gh variable set APPLE_SIGNING --body on`.

From the next version tag, the Release workflow builds the app for Apple silicon Macs on a macOS runner. Tauri signs the app and its Node with the hardened runtime and the entitlements in `app/src-tauri/macos/Entitlements.plist`, Apple notarizes it, and the ticket is stapled. The workflow then checks the signature, Gatekeeper's verdict and the stapled ticket, and fails rather than release an app that doesn't pass. The disk images go in the release beside the archives. If the variable is on but a secret is missing, the build fails and names it.
