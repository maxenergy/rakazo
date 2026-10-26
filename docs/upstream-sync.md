# Keeping a customized fork current

Keep custom changes on a long-lived branch. In this checkout, `origin` is the
upstream repository and `fork` is the publishing remote. Merge upstream into the
custom branch so both upstream history and custom commits remain intact.

Before syncing, commit reviewed source changes and make sure `git status --short`
is empty. Never stage local configuration, credentials, logs, or runtime data.

```powershell
$syncStamp = Get-Date -Format yyyyMMdd-HHmmss
git branch "backup/custom-before-sync-$syncStamp"
git fetch origin main
git merge --no-ff origin/main
```

If the merge conflicts, resolve each affected file while preserving both sets of
behavior, then review and commit the resolution. Do not reset the custom branch
to upstream or reapply its full patch onto an already customized checkout.

Validate the merged tree before publishing:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

On a local machine, use desktop unit tests; leave the desktop Playwright suite
to CI. The full unit suite also includes Linux shell, Unix socket, and POSIX
permission tests. Run those on Linux or in CI, and run the applicable tests on
Windows. Review the source diff and scan it for secrets before pushing.

Export the custom changes relative to the exact upstream revision:

```powershell
New-Item -ItemType Directory -Force artifacts | Out-Null
git rev-parse origin/main | Set-Content artifacts/custom.base.txt
git rev-parse HEAD | Set-Content artifacts/custom.head.txt
git diff --binary --full-index --output=artifacts/custom.patch origin/main HEAD
git push fork HEAD
```

The patch contains the differences from upstream, rather than another copy of
upstream's changes. Regenerate it after every sync. Apply it only to a separate,
clean checkout at the revision recorded in `custom.base.txt`, using
`git apply --check` before `git apply`; verify the resulting build afterward.
The existing custom branch should continue to use merges for future updates.
