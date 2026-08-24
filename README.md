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
#/public/tests/schema.json
#/private/notes/todo.md
```

Visibility is explicit in the workspace, so public and private concerns never overlap. GitHub repository settings remain responsible for who can access each data repository.

## Requirements

- GitHub CLI authenticated with `gh auth login`
- Git
- Node.js 20 or newer
- A target project hosted on GitHub

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

`init` reserves the generated `#/` namespace. If the project has `package.json`, it also adds:

```sh
npm run data:load
npm run data:publish
```

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

After merging a pull request, refresh the workspace baseline with:

```sh
gh workspace-data load
```

## Daily workflow

1. Run `load` to obtain or refresh project data.
2. Add, edit, move, or delete files under `#/public` and `#/private`.
3. Run `publish` to create or update pull requests for all changes.
4. Review and merge the pull requests.
5. Run `load` again.

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
- Losing synchronization state blocks publication rather than risking unintended remote deletion.

## Upgrade

```sh
gh extension upgrade workspace-data
```

## License

MIT
