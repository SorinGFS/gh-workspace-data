# gh-workspace-data

A GitHub CLI extension that materializes project-associated files from conventional public and private data repositories into an active target workspace, then publishes workspace changes through pull requests.

## Requirements

- GitHub CLI authenticated with `gh auth login`
- Git
- Node.js 20 or newer

## Install

```sh
gh extension install SorinGFS/gh-workspace-data
```

Run commands from any directory inside the target Git project:

```sh
gh workspace-data init
gh workspace-data load
gh workspace-data publish
```

Upgrade the installed extension with:

```sh
gh extension upgrade workspace-data
```

## Convention

For a target project with identity:

```text
github.com/owner/project
```

the default data repositories are:

```text
public:  owner/public-data
private: <authenticated-user>/private-data
```

Data repositories address project content as:

```text
<concern>/github.com/owner/project/<path>
```

The target workspace materializes it as:

```text
#/public/<concern>/<path>
#/private/<concern>/<path>
```

`init` reserves `/#/` in `.gitignore`. When `package.json` exists, it also adds generic `data:load` and `data:publish` scripts.

## Missing repositories

A missing public or private data repository does not prevent the other visibility from loading. The unavailable visibility remains an ordinary local directory and is recorded as unavailable.

Safety behavior:

- an unavailable repository with no local data is skipped;
- local data for an unavailable repository is preserved;
- publication is blocked when local data has no destination repository;
- a previously available repository becoming inaccessible blocks synchronization rather than discarding its workspace data;
- when a newly available repository and local workspace both contain project data without a common baseline, synchronization stops for explicit reconciliation.

## Publication

Publication processes all changed concerns for each visibility independently. It uses a stable contributor branch:

```text
<authenticated-user>-contrib/<project-identity>
```

An open PR receives additional commits. After a PR is merged, the next publication cycle starts from the current default branch and resets the workflow-owned branch with an exact `--force-with-lease` guard. Contributors without direct push access use their fork for the public PR.

## Repository overrides

Nonstandard data repository identities can be supplied without adding target-project metadata:

```sh
WORKSPACE_DATA_PUBLIC_REPOSITORY=organization/shared-data gh workspace-data load
WORKSPACE_DATA_PRIVATE_REPOSITORY=user/personal-data gh workspace-data load
```

Use the same overrides consistently for load and publish operations.

## Generated state

`#/.data-state.json` records exact source revisions, repository availability, and active pull-request state. The complete `#/` directory is generated and must remain excluded from the target repository.

## License

MIT
