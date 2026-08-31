# gh-workspace-data

Keep useful project files outside the project repository without keeping them outside your working environment.

Projects often accumulate material that belongs with the project but not in its source repository: private notes, research, experiments, optional test suites, benchmarks, extended documentation, fixtures, or contributor-maintained tools. `gh-workspace-data` stores that material in separate GitHub repositories and brings only the files for the current project into its workspace.

The materialized files are ordinary files under `#/`. Editors, terminals, and project tools can use them normally, while Git and npm exclude the generated workspace namespace from the target project.

## How it works

The extension identifies the target project from its Git `origin`. For example:

```text
github.com/acme/widget
```

It then finds that project's content in two conventional data repositories:

```text
acme/public-data       collaborative project data
alice/private-data    Alice's personal project data
```

Data is grouped by an open-ended **concern** such as `tests`, `notes`, or `benchmarks`:

```text
acme/public-data/tests/github.com/acme/widget/schema.json
alice/private-data/notes/github.com/acme/widget/todo.md
```

Inside Alice's checkout of `widget`, those files appear as:

```text
#/.data-state.json
#/version-layers.js
#/public/tests/schema.json
#/private/notes/todo.md
```

The extension owns `version-layers.js` and refreshes it from its installed runtime source. Public and private test or benchmark dispatchers can import the same helper through `../../version-layers.js`; it is never published to either data repository.

Visibility is explicit in the workspace, so public and private concerns never overlap. GitHub repository settings remain responsible for who can access each data repository.

## Generated runtime support

`#/version-layers.js` provides the common deterministic discovery contract used by materialized test and benchmark dispatchers. From `#/public/<concern>/index.js` or `#/private/<concern>/index.js`, load it with:

```js
const {
  compareNames,
  compareNumericNames,
  discoverVersionLayers,
  readDirectories,
  versionPattern
} = require('../../version-layers.js');
```

`discoverVersionLayers(root, packageVersion)` returns the base layer, matching major layer, matching major/minor layer, and eligible complete-version layers in ascending order within the package major. Prerelease and build package versions use their numeric `major.minor.patch` core.

A dispatcher whose selected callback preserves older expectations can request cumulative semantic-version layers:

```js
const layers = discoverVersionLayers(root, packageVersion, {
  backwardsCompatible: true
});
```

In this mode, every version layer whose semantic introduction point is not newer than the package is eligible, including layers from older majors. Omitted components are treated as zero: `v15` means `15.0.0`, while `v15.1` means `15.1.0`. Layers run in ascending semantic order; equal introduction points run from least to most specific, such as `v17`, `v17.0`, then `v17.0.0`. The option must be boolean and defaults to `false`, preserving exact-scope behavior for existing dispatchers.

Public test dispatchers can expose this choice in `#/public/tests/index.json` alongside the callback name:

```json
{
  "callback": "isIdnHostname",
  "backwardsCompatible": true
}
```

The setting describes the selected callback's compatibility contract. Set it only when older fixture expectations remain valid for newer package versions, allowing version folders to store deltas without copying prior tests. The comparators provide locale-independent lexical ordering and arbitrary-size numeric ordering.

The helper is generated extension infrastructure rather than public or private repository content. Every initialized command restores its canonical installed bytes before data synchronization proceeds.

## Requirements

- GitHub CLI authenticated with `gh auth login`
- Git
- Node.js 20 or newer
- A target project hosted on GitHub

## Compatibility

Automated tests cover Windows, macOS, and Linux on Node.js 20, 22, and 24. The test matrix exercises the CLI entry point, workspace replacement and rollback, ignore-policy handling, and isolated Git publication history.

Authenticated GitHub API behavior remains provided by the installed GitHub CLI.

## Install

```sh
gh extension install SorinGFS/gh-workspace-data
```

The extension is installed for the current user and becomes available in every target repository as:

```sh
gh workspace-data
```

## Get started

From any directory inside a target project:

```sh
gh workspace-data init
gh workspace-data load
```

`init` reserves the generated `#/` namespace, enforces its ignore policy, and installs the shared `#/version-layers.js` runtime helper. It does not add project-local command adapters; use the extension commands directly.

`load` discovers and materializes every concern for the current project. A missing public or private data repository is skipped, so users may maintain either or both.

Before publishing to a data repository, create it on GitHub with the intended visibility and at least one initial commit. The public repository normally belongs to the target project owner; the private repository normally belongs to the authenticated user.

To create new data, add ordinary files beneath the appropriate visibility and concern:

```text
#/public/examples/example.json
#/private/notes/design.md
```

Then publish all changes:

```sh
gh workspace-data publish
```

The extension translates the workspace paths back to the correct project paths in each data repository and opens or updates separate pull requests. It never pushes directly to a default branch.

For repositories owned by the authenticated GitHub user, publishing can also merge the resulting pull requests and reload successfully merged data in one command:

```sh
gh workspace-data publish --merge-owned
```

This option remains review-first for organization-owned repositories, repositories owned by another user, and fork-based contributions. Before merging, it verifies that the pull request is still open and that its repository, branches, and head commit match the publication produced by the current invocation. It uses an ordinary squash merge without administrator bypass, and a successful merge closes the pull request automatically.

If checks, branch protection, a merge queue, or another GitHub condition prevents an immediate merge, the pull request remains available and its reload is deferred. Run `gh workspace-data load` after the merge completes. Successfully merged data is reloaded even when another publication remains deferred or open for review.

After merging a pull request manually, you may immediately refresh the workspace baseline with:

```sh
gh workspace-data load
```

This refresh is recommended but optional. If you continue editing and publish again without loading, the extension starts a new PR cycle from the latest default branch and applies only the changes made after the previous publication. Conflicting default-branch changes still stop publication for reconciliation.

## Daily workflow

1. Run `load` to obtain or refresh project data.
2. Add, edit, move, or delete files under `#/public` and `#/private`.
3. Run `publish` to create or update pull requests for all changes.
4. Review and merge the pull requests, or use `publish --merge-owned` for authenticated-user-owned repositories.
5. Optionally run `load` after manual or deferred merges, or continue editing and let the next `publish` begin a new cycle from the merged default branch.

Deleting a loaded file or concern and then publishing intentionally deletes its corresponding data-repository content. If remote and workspace changes conflict, synchronization stops instead of choosing a version silently.

## Default repositories

The defaults contain no hardcoded user identity:

```text
public:  <target-project-owner>/public-data
private: <authenticated-GitHub-user>/private-data
```

For a contributor working on someone else's project, public changes are proposed to the project owner's data repository through a branch or fork, while private data remains associated with the contributor's own repository.

A missing repository does not prevent the other one from working. Local files targeting a missing repository are preserved, but publication is blocked until that repository exists and is accessible.

## Repository overrides

Use environment variables when repository names do not follow the defaults:

```sh
WORKSPACE_DATA_PUBLIC_REPOSITORY=organization/shared-data gh workspace-data load
WORKSPACE_DATA_PRIVATE_REPOSITORY=user/personal-data gh workspace-data load
```

Use the same overrides for subsequent load and publish operations.

## Workspace safety

- `#/` is generated workspace state and is excluded from the target Git repository.
- Existing `.npmignore` files also exclude `/#/`; an absent `.npmignore` is left absent so npm continues using `.gitignore`.
- Materialized components use ordinary files and directories, never filesystem links.
- Generated synchronization state tracks source revisions and open pull requests; do not edit it manually.
- `#/version-layers.js` is extension-owned generated runtime support shared by public and private dispatchers; do not edit it manually.
- Root-level generated runtime support is excluded from public and private publication.
- Losing synchronization state blocks publication rather than risking unintended remote deletion.

## Tests

The repository includes 26 isolated tests covering CLI routing, ignore-policy handling, generated runtime support, exact and backwards-compatible version ordering, option validation, owned-PR merge qualification, deferred reload behavior, publication history, nested-directory invocation, unchanged-snapshot retention, transient rename retries, workspace replacement, and rollback. The suite uses temporary repositories and injected GitHub operations so it does not publish or merge live workspace data.

Run the complete suite and syntax validation from the repository:

```sh
npm test
npm run check
```

GitHub Actions runs both commands on Node.js 20, 22, and 24 across Ubuntu, Windows, and macOS. Authenticated GitHub API behavior remains supplied by the installed GitHub CLI rather than exercised against live data repositories during the isolated test suite.

## Upgrade

```sh
gh extension upgrade workspace-data
```

## License

MIT
