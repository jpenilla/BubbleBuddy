# Reference maintenance

## Pinning

- For a reference repository corresponding to a dependency, pin the canonical release tag matching the resolved version used by the relevant package or workspace. Prefer resolution metadata such as `pnpm-lock.yaml`, `package-lock.json`, or `Cargo.lock` over declared version ranges.
- Confirm the package's canonical repository URL and release-tag convention; monorepos may use package-prefixed tags.
- Pin other reference repositories to reviewed commits from their recorded update branches.
- Resolve tags directly instead of using `git describe`; a commit can have several tags.
- The gitlink is exact. The inventory records the meaningful tag or update branch; an update branch never advances the gitlink automatically.

## Add or update

Use canonical HTTPS URLs, `shallow = true`, and clean detached checkouts. The commands below use `path`, `url`, and `ref` for the submodule path, repository URL, and tag or update branch; they assume the submodule name equals its path.

To add the checkout:

```bash
git submodule add --depth 1 "$url" "$path"
git config -f .gitmodules "submodule.$path.shallow" true
```

For a release tag, remove any stale branch setting, resolve the tag, and detach at its commit:

```bash
git config -f .gitmodules --unset-all "submodule.$path.branch" 2>/dev/null || true
git -C "$path" fetch --depth 1 origin "refs/tags/$ref:refs/tags/$ref"
target=$(git -C "$path" rev-parse "refs/tags/$ref^{commit}")
git -C "$path" checkout --detach "$target"
```

For an update branch, fetch its candidate tip and review it against the current pin before recording the branch and detaching; do not continue until that review is done:

```bash
git -C "$path" fetch --depth 1 origin "+refs/heads/$ref:refs/remotes/origin/$ref"
target=$(git -C "$path" rev-parse "origin/$ref")
# Required: review the candidate target against the existing pin before continuing.
git config -f .gitmodules "submodule.$path.branch" "$ref"
git -C "$path" checkout --detach "$target"
```

For ref-kind, URL, or path changes, remove stale metadata and synchronize `.gitmodules`, local configuration, the inventory, checkout data, and the gitlink.

Stage only the intended metadata and gitlink; use selective staging when metadata files contain unrelated changes. Fetch only the required tag or branch when possible. Do not update unrelated refs or commit unless asked.

## Remove

First confirm the checkout is clean. Then remove its gitlink, `.gitmodules` entry, inventory row, and local module data:

```bash
test -n "$path"
test -z "$(git -C "$path" status --porcelain)"
git submodule deinit -- "$path"
git rm -- "$path"
rm -rf -- "$(git rev-parse --git-path "modules/$path")"
```

## Validation

Inspect the configured paths and indexed gitlinks and cross-check them against the inventory. They must match exactly, every gitlink mode must be `160000`, every URL must be canonical, and every submodule must set `shallow = true`:

```bash
git config -f .gitmodules --get-regexp '^submodule\..*\.(path|url|branch|shallow)$'
git ls-files --stage repos/
```

Initialized checkouts must match their gitlinks, be clean, and use detached HEADs. Any `-`, `+`, or `U` prefix is a failure:

```bash
! git submodule status | grep -Eq '^[-+U]'
git submodule foreach --quiet '
  test -z "$(git status --porcelain)" &&
  test -z "$(git symbolic-ref -q HEAD)"
'
```

For a recorded tag, verify its commit equals the indexed gitlink:

```bash
gitlink=$(git ls-files --stage "$path" | awk '{print $2}')
test "$(git -C "$path" rev-parse "refs/tags/$ref^{commit}")" = "$gitlink"
```

For an update branch, refresh `origin/$ref`, deepen shallow history as needed for a conclusive ancestry check, and verify the branch contains the gitlink:

```bash
git -C "$path" fetch --depth 1 origin "+refs/heads/$ref:refs/remotes/origin/$ref"
gitlink=$(git ls-files --stage "$path" | awk '{print $2}')
git -C "$path" merge-base --is-ancestor "$gitlink" "origin/$ref"
```

Local shallowness is not required. Finish with `git diff --check`, `git diff --cached --check`, and relevant project checks.
