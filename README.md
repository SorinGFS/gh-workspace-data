# gh-workspace-data

Keep project-related files outside the project repository without keeping them outside the working environment.

Projects often accumulate optional tests, benchmarks, fixtures, notes, research, experiments, extended documentation, and contributor tools that should not live in the package repository. `gh-workspace-data` stores that material in separate GitHub repositories and materializes only the current project's files under `#/`.

The materialized files are ordinary files. Editors, terminals, and project tools can use them normally, while the generated namespace remains excluded from the target project's Git and npm contents.

## At a glance

For a project whose Git `origin` identifies `github.com/acme/widget`, the default sources are:

| Visibility | Default repository | Intended use |
| --- | --- | --- |
| Public | `acme/public-data` | Collaborative data associated with the project |
| Private | `<authenticated-user>/private-data` | Personal or restricted data associated with the project |

Data is grouped first by an open-ended **concern** such as `tests`, `benchmarks`, `notes`, or `examples`:

```text
Repository storage                                      Project workspace
acme/public-data/tests/github.com/acme/widget/...       #/public/tests/...
alice/private-data/notes/github.com/acme/widget/...     #/private/notes/...
```

Public and private concerns never overlap in the workspace. GitHub repository visibility and access settings remain responsible for confidentiality.

The normal workflow is:

```sh
gh workspace-data init
gh workspace-data load
# Edit ordinary files below #/public or #/private.
gh workspace-data publish
```

`publish` opens or updates pull requests; it never pushes changes directly to a data repository's default branch.

## Versioned data folders

A concern can keep all data at its root, divide it into semantic-version folders, or combine both:

```text
#/public/tests/
  index.js                 # Base data: always available
  index.json
  v15.1/                   # Version layer introduced at 15.1.0
    0/
  v16.0/                   # Version layer introduced at 16.0.0
    0/
  v17.0.2/                 # Complete version layer
    regression/

#/private/benchmarks/
  index.js                 # Private concerns use the same layout
  v17/
    experimental-scenario/
```

The extension synchronizes these directories as ordinary data. It does not decide which version layers a test runner, benchmark, or other consumer should execute. Consumers opt into selection by importing the generated `#/version-layers.js` helper and calling `discoverVersionLayers`.

### Selection modes

`discoverVersionLayers(root, packageVersion)` supports two policies:

| Policy | Invocation | Meaning |
| --- | --- | --- |
| Exact scope | `discoverVersionLayers(root, version)` | Base data, matching major and major/minor folders, plus eligible complete versions from the same major |
| Backwards compatible | `discoverVersionLayers(root, version, { backwardsCompatible: true })` | Base data plus every semantic-version layer whose introduction point is not newer than the package |

For package version `1.2.3`, exact-scope discovery includes:

```text
.          base layer
v1         matching major
v1.2       matching major/minor
v1.0.0     complete version in major 1 and not newer than 1.2.3
v1.1.3     complete version in major 1 and not newer than 1.2.3
v1.2.3     exact complete version
```

It excludes `v1.1` because partial minor layers must match the package minor, `v1.2.4` because it is newer, and every `v2` layer because it belongs to another major.

With `backwardsCompatible: true`, every valid layer at or before `1.2.3` is eligible across major boundaries. Partial folders are introduction points: `v1` means `1.0.0`, and `v1.2` means `1.2.0`. Layers run in ascending semantic order. Equal introduction points run from least to most specific, for example `v1`, `v1.0`, then `v1.0.0`.

Use cumulative discovery only when older expectations remain valid for the newer package. It supports delta-only folders, but it must not be used merely to make older data visible when that data describes an incompatible contract.

<details>
<summary><strong>Dispatcher configuration and mixed concerns</strong></summary>

A public test dispatcher can expose cumulative fixture selection in `#/public/tests/index.json`:

```json
{
  "callback": "isIdnHostname",
  "backwardsCompatible": true
}
```

This JSON file is a dispatcher convention; `gh-workspace-data` does not interpret it. The dispatcher decides how the setting applies. For example, a test dispatcher may accumulate numeric callback fixtures while retaining exact-scope selection for explicit conformance suites.

The same helper and policies are available to private concerns. Visibility changes where data is stored and materialized, not how semantic versions are compared.

Directory names are version selectors only when they match:

```text
v<major>
v<major>.<minor>
v<major>.<minor>.<patch>
```

Components use non-negative decimal integers without leading zeroes except `0`. Package prerelease and build versions use their numeric `major.minor.patch` core.

</details>

## Install and get started

### Requirements

- GitHub CLI authenticated with `gh auth login`
- Git
- Node.js 20 or newer
- A target project hosted on GitHub

Install the extension for the current user:

```sh
gh extension install SorinGFS/gh-workspace-data
```

From any directory inside a target project, initialize and load its data:

```sh
gh workspace-data init
gh workspace-data load
```

`init` reserves the generated `#/` namespace, enforces its ignore policy, and installs `#/version-layers.js`. It does not add project-local wrappers or scripts.

`load` derives the project identity from Git `origin`, discovers every matching public and private concern, and materializes them in the workspace. A missing public or private repository is skipped, so either visibility can be used independently.

Before publishing to a data repository, create it on GitHub with the intended visibility and at least one initial commit. Then add ordinary files beneath a visibility and concern:

```text
#/public/examples/example.json
#/private/notes/design.md
```

Publish all changed concerns:

```sh
gh workspace-data publish
```

## Loading and publication

1. Run `load` to obtain or refresh public and private project data.
2. Add, edit, move, or delete files under `#/public` and `#/private`.
3. Run `publish` to create or update separate pull requests for changed public and private data.
4. Review and merge those pull requests, or use `publish --merge-owned` where appropriate.
5. Run `load` after a manual or deferred merge to refresh immediately, or let the next publication begin from the merged default branch.

Deleting loaded files or complete concerns and publishing intentionally deletes their corresponding data-repository content. If remote and workspace edits conflict, synchronization stops instead of selecting a version silently.

<details>
<summary><strong>Automatic merging for repositories you own</strong></summary>

For repositories owned by the authenticated GitHub user, publication can merge qualifying pull requests and reload successfully merged data in one command:

```sh
gh workspace-data publish --merge-owned
```

This option remains review-first for organization-owned repositories, repositories owned by another user, and fork-based contributions. Before merging, it verifies that the pull request is open and that its repository, branches, and head commit match the publication produced by the current invocation. It uses an ordinary squash merge without administrator bypass.

If checks, branch protection, a merge queue, or another GitHub condition prevents an immediate merge, the pull request remains open and reload is deferred. Successfully merged data is still reloaded when another publication remains deferred or open for review.

</details>

<details>
<summary><strong>Publishing again without an intervening load</strong></summary>

After merging manually, refreshing with `gh workspace-data load` is recommended but optional. If editing continues without loading, the next `publish` starts a new pull-request cycle from the latest default branch and applies only changes made after the previous publication. Conflicting default-branch edits still stop publication for reconciliation.

</details>

## Repository selection

The defaults contain no hardcoded user identity:

```text
public:  <target-project-owner>/public-data
private: <authenticated-GitHub-user>/private-data
```

For a contributor working on another owner's project, public changes are proposed to the project owner's data repository through a branch or fork. Private data remains associated with the contributor's own repository.

A missing repository does not prevent the other visibility from working. Local files targeting a missing repository are preserved, but publication for that visibility is blocked until the repository exists and is accessible.

<details>
<summary><strong>Repository overrides</strong></summary>

Use environment variables when repository names do not follow the defaults:

```sh
WORKSPACE_DATA_PUBLIC_REPOSITORY=organization/shared-data gh workspace-data load
WORKSPACE_DATA_PRIVATE_REPOSITORY=user/personal-data gh workspace-data load
```

Use the same overrides for subsequent `load` and `publish` operations.

</details>

## Generated runtime support

`#/version-layers.js` is extension-owned infrastructure shared by public and private consumers. From `#/public/<concern>/index.js` or `#/private/<concern>/index.js`, import it with:

```js
const {
  compareNames,
  compareNumericNames,
  discoverVersionLayers,
  readDirectories,
  versionPattern
} = require('../../version-layers.js');
```

The comparators provide locale-independent lexical ordering and arbitrary-size numeric ordering. `readDirectories` returns direct ordinary child directories, and `versionPattern` identifies supported version-layer names.

The helper is never published to either data repository. Every initialized command restores its canonical installed bytes before synchronization, so it should not be edited manually.

<details>
<summary><strong>Why the helper is outside public and private concerns</strong></summary>

Public and private dispatchers may need identical version-selection behavior. Keeping one generated helper at `#/version-layers.js` avoids copying runtime code into both data repositories and prevents those copies from drifting. CI that checks out data directly must materialize the helper separately from the matching `gh-workspace-data` version.

</details>

## Workspace safety

- `#/` is generated workspace state and is excluded from the target Git repository.
- Existing `.npmignore` files also exclude `/#/`; an absent `.npmignore` remains absent so npm continues using `.gitignore`.
- Materialized components use ordinary files and directories, never filesystem links.
- `#/.data-state.json` tracks source revisions and open pull requests; do not edit it manually.
- Root-level generated runtime support is excluded from public and private publication.
- Losing synchronization state blocks publication rather than risking unintended remote deletion.

## Compatibility and verification

Automated tests cover Windows, macOS, and Linux on Node.js 20, 22, and 24. The matrix exercises the CLI entry point, ignore-policy handling, generated runtime support, exact and backwards-compatible version ordering, owned-pull-request merge qualification, deferred reload behavior, publication history, workspace replacement, and rollback.

Run syntax validation and all 26 isolated tests with:

```sh
npm run check
npm test
```

The tests use temporary repositories and injected GitHub operations; they do not publish or merge live workspace data. Authenticated GitHub API behavior remains supplied by the installed GitHub CLI.

## Upgrade

```sh
gh extension upgrade workspace-data
```

## License

MIT
