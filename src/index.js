// Synchronize all project-matched public and private data through ordinary # workspace files.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let projectRoot = path.resolve(process.cwd());
let namespaceRoot;
let statePath;
let dataRepositories;
const protectedNames = new Set([
    '.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.terraform.d',
    '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.gitconfig',
    '.git-credentials', '.netrc', '.bash_history', '.zsh_history',
    'microsoft.powershell_profile.ps1', 'desktop.ini', 'thumbs.db', '.ds_store'
]);

// Stop an unsafe or ambiguous synchronization path with a concise explanation.
function fail(message) {
    throw new Error(message);
}

// Run an inspected local executor without invoking a shell or accepting unexpected exit states.
function run(executable, args, options = {}) {
    const acceptedStatuses = options.acceptedStatuses || [0];
    const result = spawnSync(executable, args, {
        cwd: options.cwd || projectRoot,
        encoding: 'utf8',
        env: options.env || process.env,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
    });

    if (result.error) {
        fail(`Unable to run ${executable}: ${result.error.message}`);
    }
    if (!acceptedStatuses.includes(result.status)) {
        const detail = (result.stderr || result.stdout || '').trim();
        fail(detail || `${executable} ${args.join(' ')} failed with status ${result.status}.`);
    }
    return result;
}

// Invoke Git against one explicit repository working directory.
function git(repositoryPath, args, options = {}) {
    return run('git', ['-C', repositoryPath, ...args], options);
}

// Establish the canonical project root independently of the installed extension location.
function establishProjectRoot() {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).stdout.trim();
    if (!root) {
        fail('The current directory is not inside a canonical Git project.');
    }
    return path.resolve(root);
}

// Retrieve authenticated GitHub state and optionally classify a missing resource.
function ghApi(endpoint, options = {}) {
    const result = run('gh', ['api', endpoint], { acceptedStatuses: options.allowMissing ? [0, 1] : [0] });
    if (result.status !== 0) {
        if (options.allowMissing && /HTTP 404/i.test(result.stderr)) {
            return null;
        }
        fail(result.stderr.trim() || `GitHub API request failed: ${endpoint}`);
    }

    try {
        return JSON.parse(result.stdout);
    } catch (error) {
        fail(`GitHub API returned invalid JSON for ${endpoint}: ${error.message}`);
    }
}

// Normalize the canonical origin into the hosted project path used by both data repositories.
function deriveProjectIdentity() {
    const remote = git(projectRoot, ['remote', 'get-url', 'origin']).stdout.trim();
    let hostname;
    let repositoryPath;

    if (/^[^@\s]+@[^:\s]+:.+$/.test(remote)) {
        const match = remote.match(/^[^@\s]+@([^:\s]+):(.+)$/);
        [, hostname, repositoryPath] = match;
    } else {
        let url;
        try {
            url = new URL(remote);
        } catch {
            fail(`Cannot normalize the canonical origin: ${remote}`);
        }
        if (url.username && url.username !== 'git') {
            fail('The canonical origin must not contain user credentials.');
        }
        if (url.port || url.search || url.hash) {
            fail(`The canonical origin uses an unsupported host, port, query, or fragment: ${remote}`);
        }
        hostname = url.hostname;
        repositoryPath = url.pathname.replace(/^\/+/, '');
    }

    repositoryPath = repositoryPath.replace(/\.git$/i, '').replace(/\/+$/, '');
    const segments = repositoryPath.split('/');
    if (!hostname || segments.length < 2 || segments.some((segment) => !isSafeSegment(segment))) {
        fail(`Cannot derive a filesystem-safe project identity from origin: ${remote}`);
    }
    return `${hostname.toLowerCase()}/${segments.join('/')}`;
}

// Restrict generated path segments to portable names outside protected artifact classes.
function isSafeSegment(segment) {
    return Boolean(segment)
        && segment !== '.'
        && segment !== '..'
        && !segment.includes('\\')
        && !protectedNames.has(segment.toLowerCase());
}

// Resolve a repository-relative Git path beneath a known ordinary directory boundary.
function resolveRelativePath(root, relativePath) {
    const segments = relativePath.split('/');
    if (segments.some((segment) => !isSafeSegment(segment))) {
        fail(`Data contains an unsafe or protected path: ${relativePath}`);
    }

    const destination = path.resolve(root, ...segments);
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
        fail(`Data path escapes its materialization root: ${relativePath}`);
    }
    return destination;
}

// Validate a concern name used as the first addressing segment in a data repository.
function validateConcern(concern) {
    if (!/^[A-Za-z0-9._-]+$/.test(concern) || !isSafeSegment(concern)) {
        fail(`Invalid or protected concern name: ${concern}`);
    }
}

// Derive conventional data repositories without embedding a tool publisher or user identity.
function deriveDataRepositories(projectIdentity, actor) {
    const identitySegments = projectIdentity.split('/');
    if (identitySegments[0] !== 'github.com' || identitySegments.length < 3) {
        fail('Automatic data repository discovery currently supports github.com projects.');
    }

    const repositories = {
        public: process.env.WORKSPACE_DATA_PUBLIC_REPOSITORY || `${identitySegments[1]}/public-data`,
        private: process.env.WORKSPACE_DATA_PRIVATE_REPOSITORY || `${actor}/private-data`
    };

    // Validate optional overrides through the same logical owner/repository contract as defaults.
    for (const [visibility, repository] of Object.entries(repositories)) {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
            fail(`Invalid ${visibility} data repository identity: ${repository}`);
        }
    }
    return repositories;
}

// Obtain repository metadata while allowing a conventionally absent visibility source.
function readRepositoryMetadata(repository, allowMissing = false) {
    const metadata = ghApi(`repos/${repository}`, { allowMissing });
    if (!metadata) {
        return null;
    }
    if (!metadata.default_branch || typeof metadata.default_branch !== 'string') {
        fail(`Repository ${repository} has no usable default branch.`);
    }
    return metadata;
}

// Clone a data repository only into runtime-controlled temporary storage.
function cloneRepository(repository, destination) {
    run('gh', ['repo', 'clone', repository, destination, '--', '--no-tags', '--config', 'core.autocrlf=false']);
    return destination;
}

// List every tracked object beneath a concern/project identity without exposing unrelated content.
function listProjectEntries(repositoryPath, revision, projectIdentity) {
    const result = git(repositoryPath, ['ls-tree', '-r', '-z', revision]);
    const entries = [];

    // Parse NUL-delimited Git records so whitespace in data filenames remains unambiguous.
    for (const record of result.stdout.split('\0')) {
        if (!record) {
            continue;
        }
        const separator = record.indexOf('\t');
        const metadata = record.slice(0, separator).split(' ');
        const gitPath = record.slice(separator + 1);
        const firstSeparator = gitPath.indexOf('/');
        if (separator < 0 || metadata.length !== 3) {
            fail('Git returned an unsupported tree record.');
        }
        if (firstSeparator < 1) {
            continue;
        }

        const concern = gitPath.slice(0, firstSeparator);
        const sourcePrefix = `${concern}/${projectIdentity}`;
        if (!gitPath.startsWith(`${sourcePrefix}/`)) {
            continue;
        }

        validateConcern(concern);
        const relativePath = gitPath.slice(sourcePrefix.length + 1);
        resolveRelativePath(projectRoot, relativePath);
        entries.push({ mode: metadata[0], type: metadata[1], gitPath, concern, relativePath });
    }
    return entries;
}

// Group selected Git entries by their automatically discovered concern.
function groupEntriesByConcern(entries) {
    const concerns = new Map();

    // Preserve each concern as one deterministic source subtree.
    for (const entry of entries) {
        if (!concerns.has(entry.concern)) {
            concerns.set(entry.concern, []);
        }
        concerns.get(entry.concern).push(entry);
    }
    return concerns;
}

// Inspect workspace content recursively and reject links, special objects, and protected names.
function inventoryOrdinaryFiles(root, current = root, files = []) {
    if (!fs.existsSync(current)) {
        return files;
    }

    // Traverse only the selected materialized visibility or concern tree.
    for (const name of fs.readdirSync(current)) {
        if (!isSafeSegment(name)) {
            fail(`Workspace data contains an unsafe or protected name: ${path.join(current, name)}`);
        }
        const candidate = path.join(current, name);
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) {
            fail(`Workspace data contains a filesystem link: ${candidate}`);
        }
        if (stat.isDirectory()) {
            inventoryOrdinaryFiles(root, candidate, files);
        } else if (stat.isFile()) {
            files.push(path.relative(root, candidate).split(path.sep).join('/'));
        } else {
            fail(`Workspace data contains an unsupported filesystem object: ${candidate}`);
        }
    }
    return files.sort();
}

// Discover local concerns from one complete visibility snapshot.
function listWorkspaceConcerns(visibility) {
    const visibilityRoot = path.join(namespaceRoot, visibility);
    if (!fs.existsSync(visibilityRoot)) {
        return [];
    }
    if (!fs.lstatSync(visibilityRoot).isDirectory()) {
        fail(`#/${visibility} must be an ordinary directory.`);
    }

    const concerns = [];

    // Require every direct visibility child to represent one complete concern directory.
    for (const concern of fs.readdirSync(visibilityRoot)) {
        validateConcern(concern);
        const concernRoot = path.join(visibilityRoot, concern);
        const stat = fs.lstatSync(concernRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            fail(`#/${visibility}/${concern} must be an ordinary directory.`);
        }
        inventoryOrdinaryFiles(concernRoot);
        concerns.push(concern);
    }
    return concerns.sort();
}

// Preserve local data for an unavailable repository without inventing a remote baseline.
function stageUnavailableVisibility(visibility, destination) {
    fs.mkdirSync(destination, { recursive: true });

    // Copy only validated concern directories from the current visibility snapshot.
    for (const concern of listWorkspaceConcerns(visibility)) {
        const source = path.join(namespaceRoot, visibility, concern);
        const target = path.join(destination, concern);
        fs.cpSync(source, target, { recursive: true, errorOnExist: true });
        inventoryOrdinaryFiles(target);
    }
}

// Ensure an exact historical commit is available before deriving workspace changes from it.
function ensureCommit(repositoryPath, revision, pullRequestNumber = null) {
    let check = git(repositoryPath, ['cat-file', '-e', `${revision}^{commit}`], { acceptedStatuses: [0, 1, 128] });
    if (check.status === 0) {
        return;
    }
    if (pullRequestNumber) {
        git(repositoryPath, ['fetch', 'origin', `refs/pull/${pullRequestNumber}/head`]);
        check = git(repositoryPath, ['cat-file', '-e', `${revision}^{commit}`], { acceptedStatuses: [0, 1, 128] });
    }
    if (check.status !== 0) {
        git(repositoryPath, ['fetch', 'origin', revision]);
        check = git(repositoryPath, ['cat-file', '-e', `${revision}^{commit}`], { acceptedStatuses: [0, 1, 128] });
    }
    if (check.status !== 0) {
        fail(`Recorded base revision is unavailable: ${revision}`);
    }
}

// Mirror the complete local visibility snapshot onto its recorded base and commit the resulting patch.
function createWorkspacePatch(repositoryPath, baseRevision, visibility, projectIdentity, actor, pullRequestNumber = null) {
    ensureCommit(repositoryPath, baseRevision, pullRequestNumber);
    git(repositoryPath, ['checkout', '--detach', '--force', baseRevision]);

    const baseConcerns = [...groupEntriesByConcern(listProjectEntries(repositoryPath, baseRevision, projectIdentity)).keys()];
    const localConcerns = listWorkspaceConcerns(visibility);

    // Remove every previously tracked project subtree so local absence has explicit deletion semantics.
    for (const concern of baseConcerns) {
        fs.rmSync(resolveRelativePath(repositoryPath, `${concern}/${projectIdentity}`), { recursive: true, force: true });
    }

    // Copy each current concern as ordinary files into its derived repository path.
    for (const concern of localConcerns) {
        const source = path.join(namespaceRoot, visibility, concern);
        const destination = resolveRelativePath(repositoryPath, `${concern}/${projectIdentity}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.cpSync(source, destination, { recursive: true, errorOnExist: true });
    }

    git(repositoryPath, ['add', '-A', '--', '.']);
    const changed = git(repositoryPath, ['diff', '--cached', '--quiet'], { acceptedStatuses: [0, 1] });
    if (changed.status === 0) {
        return null;
    }

    const identityArgs = ['-c', `user.name=${actor}`, '-c', `user.email=${actor}@users.noreply.github.com`];
    git(repositoryPath, [...identityArgs, 'commit', '-m', `Update workspace data for ${projectIdentity}`]);
    return git(repositoryPath, ['rev-parse', 'HEAD']).stdout.trim();
}

// Fetch the remote state represented by an active or recently closed pull request.
function resolveLoadTarget(repositoryPath, repository, repositoryState, defaultRevision) {
    if (!repositoryState || !repositoryState.pullRequest) {
        return { revision: defaultRevision, pullRequest: null };
    }

    const number = repositoryState.pullRequest.number;
    const pullRequest = ghApi(`repos/${repository}/pulls/${number}`);
    if (pullRequest.merged_at) {
        return { revision: defaultRevision, pullRequest: null };
    }
    if (!pullRequest.head || !pullRequest.head.repo || !pullRequest.head.ref || !pullRequest.head.sha) {
        fail(`Pull request ${repository}#${number} no longer exposes a recoverable head branch.`);
    }

    const trackedRepository = pullRequest.head.repo.full_name;
    git(repositoryPath, ['remote', 'add', 'tracked-data-head', `https://github.com/${trackedRepository}.git`]);
    git(repositoryPath, ['fetch', 'tracked-data-head', `refs/heads/${pullRequest.head.ref}`]);
    const fetchedRevision = git(repositoryPath, ['rev-parse', 'FETCH_HEAD']).stdout.trim();
    if (fetchedRevision !== pullRequest.head.sha) {
        fail(`Pull request ${repository}#${number} changed while it was being loaded.`);
    }

    return {
        revision: fetchedRevision,
        pullRequest: {
            number,
            url: pullRequest.html_url,
            headRepository: trackedRepository,
            headBranch: pullRequest.head.ref,
            baseBranch: pullRequest.base.ref,
            status: pullRequest.state
        }
    };
}

// Apply a workspace patch with Git's three-way merge semantics and surface conflicts.
function applyWorkspacePatch(repositoryPath, targetRevision, patchRevision, visibility, actor) {
    git(repositoryPath, ['checkout', '--detach', '--force', targetRevision]);
    if (!patchRevision) {
        return;
    }

    const identityArgs = ['-c', `user.name=${actor}`, '-c', `user.email=${actor}@users.noreply.github.com`];
    const cherryPick = git(repositoryPath, [...identityArgs, 'cherry-pick', patchRevision], { acceptedStatuses: [0, 1] });
    if (cherryPick.status === 0) {
        return;
    }

    const conflicts = git(repositoryPath, ['diff', '--name-only', '--diff-filter=U']).stdout.trim();
    if (conflicts) {
        git(repositoryPath, ['cherry-pick', '--abort']);
        fail(`Remote and #/${visibility} changes conflict:\n${conflicts}`);
    }

    git(repositoryPath, ['cherry-pick', '--skip']);
}

// Copy the selected project subtrees from one Git revision into a visibility staging directory.
function materializeVisibility(repositoryPath, revision, projectIdentity, destination) {
    fs.mkdirSync(destination, { recursive: true });
    const entries = listProjectEntries(repositoryPath, revision, projectIdentity);
    const concerns = groupEntriesByConcern(entries);

    // Reject Git links and submodules before transferring any source subtree into the workspace.
    for (const entry of entries) {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
            fail(`Unsupported Git object ${entry.type}/${entry.mode} at ${entry.gitPath}.`);
        }
    }

    // Copy each automatically discovered concern from the temporary checkout.
    for (const concern of concerns.keys()) {
        const source = resolveRelativePath(repositoryPath, `${concern}/${projectIdentity}`);
        const target = path.join(destination, concern);
        fs.cpSync(source, target, { recursive: true, errorOnExist: true });
        inventoryOrdinaryFiles(target);
    }
}

// Read synchronization state only when it matches the current project and complete visibility snapshots.
function readState(projectIdentity, required = false) {
    if (!fs.existsSync(statePath)) {
        if (required) {
            fail('Synchronization state is missing; publication is blocked to prevent unintended deletion.');
        }
        return null;
    }

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.version !== 1 || state.projectIdentity !== projectIdentity || !state.repositories) {
        fail('Synchronization state does not match this canonical project.');
    }

    // Validate both visibility baselines before allowing dependent synchronization work.
    for (const visibility of Object.keys(dataRepositories)) {
        const repositoryState = state.repositories[visibility];
        if (!repositoryState || repositoryState.complete !== true) {
            fail(`Synchronization state for ${visibility} data is incomplete.`);
        }

        repositoryState.availability = repositoryState.availability
            || (repositoryState.baseRevision ? 'available' : null);
        if (repositoryState.availability === 'available'
            && !/^[a-f0-9]{40,64}$/.test(repositoryState.baseRevision || '')) {
            fail(`Synchronization state for ${visibility} data has no exact base revision.`);
        }
        if (repositoryState.availability === 'missing' && repositoryState.pullRequest) {
            fail(`Synchronization state for missing ${visibility} data cannot track a pull request.`);
        }
        if (!['available', 'missing'].includes(repositoryState.availability)) {
            fail(`Synchronization state for ${visibility} data has unknown availability.`);
        }
    }
    return state;
}

// Reject unknown # content because it cannot be assigned deterministic synchronization semantics.
function verifyNamespaceShape(hasState) {
    if (!fs.existsSync(namespaceRoot)) {
        return;
    }
    if (!fs.lstatSync(namespaceRoot).isDirectory()) {
        fail('# must be an ordinary directory.');
    }

    const allowed = new Set(['public', 'private', '.data-state.json']);

    // Keep legacy manifests and unassociated root concerns outside automatic deletion decisions.
    for (const name of fs.readdirSync(namespaceRoot)) {
        if (!allowed.has(name)) {
            fail(`Unrecognized generated data path #/${name}; move or remove it before synchronization.`);
        }
    }
    if (!hasState && fs.readdirSync(namespaceRoot).length > 0) {
        fail('Existing # data has no synchronization state; refusing to infer a destructive baseline.');
    }
}

// Replace selected visibility snapshots and state with rollback for local filesystem failures.
function replaceWorkspace(stagedRoot, state, visibilities, options = {}) {
    const activeNamespaceRoot = options.namespaceRoot || namespaceRoot;
    const activeStatePath = options.statePath || statePath;
    const renameSync = options.renameSync || fs.renameSync;
    fs.mkdirSync(activeNamespaceRoot, { recursive: true });
    const operationId = `${process.pid}-${crypto.randomUUID()}`;
    const incomingRoot = path.join(activeNamespaceRoot, `.incoming-${operationId}`);
    const backups = new Map();
    const installed = new Set();
    const previousState = fs.existsSync(activeStatePath) ? fs.readFileSync(activeStatePath) : null;

    fs.cpSync(stagedRoot, incomingRoot, { recursive: true, errorOnExist: true });
    inventoryOrdinaryFiles(incomingRoot);

    try {
        // Preserve current visibility snapshots until all incoming directories are ready.
        for (const visibility of visibilities) {
            const current = path.join(activeNamespaceRoot, visibility);
            const backup = path.join(activeNamespaceRoot, `.backup-${operationId}-${visibility}`);
            if (fs.existsSync(current)) {
                renameSync(current, backup);
                backups.set(visibility, backup);
            }
            const incoming = path.join(incomingRoot, visibility);
            if (!fs.existsSync(incoming)) {
                fs.mkdirSync(incoming, { recursive: true });
            }
            renameSync(incoming, current);
            installed.add(visibility);
        }

        fs.writeFileSync(activeStatePath, `${JSON.stringify(state, null, 2)}\n`);

        // Discard backups only after materialized data and synchronization state both succeed.
        for (const backup of backups.values()) {
            fs.rmSync(backup, { recursive: true, force: true });
        }
    } catch (error) {
        // Reverse only completed replacement steps so an untouched snapshot is never deleted.
        for (const visibility of [...visibilities].reverse()) {
            const current = path.join(activeNamespaceRoot, visibility);
            if (installed.has(visibility)) {
                fs.rmSync(current, { recursive: true, force: true });
            }
            const backup = backups.get(visibility);
            if (backup && fs.existsSync(backup)) {
                renameSync(backup, current);
            }
        }
        if (previousState) {
            fs.writeFileSync(activeStatePath, previousState);
        } else {
            fs.rmSync(activeStatePath, { force: true });
        }
        throw error;
    } finally {
        fs.rmSync(incomingRoot, { recursive: true, force: true });
    }
}

// Load or reconcile every automatically matched concern from both data repositories.
function loadAll(projectIdentity, actor) {
    const previousState = readState(projectIdentity, false);
    verifyNamespaceShape(Boolean(previousState));
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-load-'));
    const stagedRoot = path.join(temporaryRoot, 'materialized');
    const nextState = { version: 1, projectIdentity, repositories: {} };

    try {
        // Reconcile each visibility independently while committing both snapshots together locally.
        for (const [visibility, repository] of Object.entries(dataRepositories)) {
            const oldRepositoryState = previousState && previousState.repositories[visibility];
            const metadata = readRepositoryMetadata(repository, true);
            if (!metadata) {
                if (oldRepositoryState && oldRepositoryState.availability === 'available') {
                    fail(`${repository} became unavailable; preserving #/${visibility} and its recorded baseline.`);
                }
                stageUnavailableVisibility(visibility, path.join(stagedRoot, visibility));
                nextState.repositories[visibility] = {
                    availability: 'missing',
                    complete: true,
                    pullRequest: null
                };
                console.log(`Skipped unavailable ${visibility} data repository ${repository}.`);
                continue;
            }

            const repositoryPath = cloneRepository(repository, path.join(temporaryRoot, `${visibility}-repository`));
            const defaultRevision = git(repositoryPath, ['rev-parse', `origin/${metadata.default_branch}`]).stdout.trim();
            const availableState = oldRepositoryState && oldRepositoryState.availability === 'available'
                ? oldRepositoryState
                : null;
            const target = resolveLoadTarget(repositoryPath, repository, availableState, defaultRevision);
            let patchRevision = null;

            if (availableState) {
                patchRevision = createWorkspacePatch(
                    repositoryPath,
                    availableState.baseRevision,
                    visibility,
                    projectIdentity,
                    actor,
                    availableState.pullRequest && availableState.pullRequest.number
                );
            } else if (listWorkspaceConcerns(visibility).length > 0) {
                const remoteEntries = listProjectEntries(repositoryPath, defaultRevision, projectIdentity);
                if (remoteEntries.length > 0) {
                    fail(`#/${visibility} and newly available ${repository} both contain project data without a shared baseline.`);
                }
                patchRevision = createWorkspacePatch(
                    repositoryPath,
                    defaultRevision,
                    visibility,
                    projectIdentity,
                    actor
                );
            }

            applyWorkspacePatch(repositoryPath, target.revision, patchRevision, visibility, actor);
            materializeVisibility(repositoryPath, 'HEAD', projectIdentity, path.join(stagedRoot, visibility));
            nextState.repositories[visibility] = {
                availability: 'available',
                defaultBranch: metadata.default_branch,
                baseRevision: target.revision,
                complete: true,
                pullRequest: target.pullRequest
            };
        }

        replaceWorkspace(stagedRoot, nextState, Object.keys(dataRepositories));
        console.log(`Loaded all data for ${projectIdentity} into #/public and #/private.`);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

// Read the stable publication branch so a new PR cycle can reset it with an exact lease.
function readPublicationBranch(pushRepository, branchName) {
    const branch = ghApi(`repos/${pushRepository}/branches/${encodeURIComponent(branchName)}`, { allowMissing: true });
    return branch ? { revision: branch.commit.sha } : null;
}

// Select the upstream repository or the authenticated contributor's fork as the push destination.
function resolvePushRepository(repository, metadata, actor) {
    if (metadata.permissions && metadata.permissions.push) {
        return repository;
    }

    const repositoryName = repository.split('/').pop();
    const fork = `${actor}/${repositoryName}`;
    let forkMetadata = ghApi(`repos/${fork}`, { allowMissing: true });
    if (!forkMetadata) {
        run('gh', ['repo', 'fork', repository, '--clone=false']);
        forkMetadata = ghApi(`repos/${fork}`);
    }
    if (!forkMetadata.fork || !forkMetadata.parent || forkMetadata.parent.full_name.toLowerCase() !== repository.toLowerCase()) {
        fail(`${fork} exists but is not a fork of ${repository}.`);
    }
    return fork;
}

// Find the contributor's open stable pull request for one canonical data repository.
function findOpenPullRequest(repository, actor, branchName) {
    const result = run('gh', [
        'pr', 'list', '--repo', repository, '--state', 'open',
        '--json', 'number,url,headRefName,headRepositoryOwner,baseRefName'
    ]);
    const pullRequests = JSON.parse(result.stdout);
    return pullRequests.find((pullRequest) => pullRequest.headRefName === branchName
        && pullRequest.headRepositoryOwner
        && pullRequest.headRepositoryOwner.login.toLowerCase() === actor.toLowerCase()) || null;
}

// Merge only invocation-verified pull requests whose destination repository belongs to the actor.
function mergeOwnedPublications(publications, actor, operations = {}) {
    const readPullRequest = operations.readPullRequest
        || ((publication) => ghApi(`repos/${publication.repository}/pulls/${publication.pullRequest.number}`));
    const mergePullRequest = operations.mergePullRequest || ((publication) => run('gh', [
        'pr', 'merge', String(publication.pullRequest.number), '--repo', publication.repository,
        '--squash', '--delete-branch', '--match-head-commit', publication.headRevision
    ], { acceptedStatuses: [0, 1] }));
    const summary = { merged: [], deferred: [], review: [] };

    // Keep fork-based and third-party destinations on the ordinary review path.
    for (const publication of publications) {
        const owned = publication.repositoryOwner.toLowerCase() === actor.toLowerCase()
            && publication.pushRepository.toLowerCase() === publication.repository.toLowerCase();
        if (!owned) {
            summary.review.push(publication.pullRequest.url);
            console.log(`Left ${publication.pullRequest.url} open for review because ${publication.repository} is not owned by ${actor}.`);
            continue;
        }

        // Re-read the PR immediately before merging and bind the operation to the published head.
        const pullRequest = readPullRequest(publication);
        const expectedHeadRepository = publication.pushRepository.toLowerCase();
        if (pullRequest.state !== 'open'
            || pullRequest.number !== publication.pullRequest.number
            || !pullRequest.head
            || !pullRequest.head.repo
            || pullRequest.head.repo.full_name.toLowerCase() !== expectedHeadRepository
            || pullRequest.head.ref !== publication.pullRequest.headBranch
            || pullRequest.head.sha !== publication.headRevision
            || !pullRequest.base
            || pullRequest.base.ref !== publication.pullRequest.baseBranch) {
            fail(`Pull request ${publication.pullRequest.url} changed after publication; refusing to merge it automatically.`);
        }

        const mergeResult = mergePullRequest(publication);
        const mergedPullRequest = readPullRequest(publication);
        if (mergedPullRequest.merged_at) {
            summary.merged.push(publication.pullRequest.url);
            console.log(`Merged owned workspace-data pull request: ${publication.pullRequest.url}`);
            continue;
        }

        const detail = (mergeResult.stderr || mergeResult.stdout || '').trim();
        summary.deferred.push({ url: publication.pullRequest.url, detail });
        console.log(`Left ${publication.pullRequest.url} open because GitHub did not merge it immediately.`);
    }
    return summary;
}

// Reload every merged destination before reporting any publication whose immediate merge was deferred.
function completeOwnedPublicationCycle(publications, actor, reload, operations = {}) {
    const mergePublications = operations.mergePublications || mergeOwnedPublications;
    const summary = mergePublications(publications, actor);
    if (summary.merged.length > 0) {
        reload();
    }
    if (summary.deferred.length > 0) {
        const details = summary.deferred.map(({ url, detail }) => `- ${url}${detail ? `: ${detail}` : ''}`).join('\n');
        fail(`Automatic merge did not complete; reload is deferred for:\n${details}`);
    }
    return summary;
}

// Merge one commit into a publication target and report version-control conflicts without choosing a winner.
function mergeCommit(repositoryPath, args, visibility, operation) {
    const result = git(repositoryPath, args, { acceptedStatuses: [0, 1] });
    if (result.status === 0) {
        return;
    }

    const conflicts = git(repositoryPath, ['diff', '--name-only', '--diff-filter=U']).stdout.trim();
    if (conflicts) {
        git(repositoryPath, [operation, '--abort']);
        fail(`${operation} conflicts while publishing #/${visibility}:\n${conflicts}`);
    }
    if (operation === 'cherry-pick') {
        git(repositoryPath, ['cherry-pick', '--skip']);
        return;
    }
    fail(`${operation} failed while publishing #/${visibility}.`);
}

// Prepare the stable branch for either an active PR update or a clean post-merge publication cycle.
function preparePublicationBranch(repositoryPath, options) {
    const {
        actor,
        branchName,
        defaultBranch,
        defaultRevision,
        patchRevision,
        publicationBranch,
        pullRequest,
        visibility
    } = options;

    if (pullRequest && !publicationBranch) {
        fail(`Open pull request ${pullRequest.url} has no recoverable publication branch.`);
    }
    if (pullRequest) {
        git(repositoryPath, ['fetch', 'publication', `refs/heads/${branchName}:refs/remotes/publication/stable`]);
        git(repositoryPath, ['checkout', '-B', branchName, 'refs/remotes/publication/stable']);
    } else {
        git(repositoryPath, ['checkout', '-B', branchName, `origin/${defaultBranch}`]);
    }

    const identityArgs = ['-c', `user.name=${actor}`, '-c', `user.email=${actor}@users.noreply.github.com`];
    if (pullRequest) {
        const defaultIncluded = git(repositoryPath, ['merge-base', '--is-ancestor', defaultRevision, 'HEAD'], { acceptedStatuses: [0, 1] });
        if (defaultIncluded.status !== 0) {
            mergeCommit(repositoryPath, [...identityArgs, 'merge', '--no-edit', defaultRevision], visibility, 'merge');
        }
    }
    mergeCommit(repositoryPath, [...identityArgs, 'cherry-pick', patchRevision], visibility, 'cherry-pick');

    return {
        forceLeaseRevision: !pullRequest && publicationBranch ? publicationBranch.revision : null
    };
}

// Publish every changed concern for one visibility through its stable contribution branch and PR.
function publishVisibility(state, visibility, projectIdentity, actor) {
    const repository = dataRepositories[visibility];
    const repositoryState = state.repositories[visibility];
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `workspace-data-publish-${visibility}-`));

    try {
        const metadata = readRepositoryMetadata(repository, true);
        const localConcerns = listWorkspaceConcerns(visibility);
        if (!metadata) {
            if (repositoryState.availability === 'available') {
                fail(`${repository} became unavailable; publication is blocked.`);
            }
            if (localConcerns.length > 0) {
                fail(`Cannot publish #/${visibility}: data repository ${repository} does not exist or is inaccessible.`);
            }
            console.log(`No ${visibility} repository or workspace data to publish.`);
            return;
        }

        if (!metadata.owner || typeof metadata.owner.login !== 'string') {
            fail(`Repository ${repository} has no verifiable owner identity.`);
        }
        const repositoryPath = cloneRepository(repository, path.join(temporaryRoot, 'repository'));
        const defaultRevision = git(repositoryPath, ['rev-parse', `origin/${metadata.default_branch}`]).stdout.trim();
        if (repositoryState.availability === 'missing') {
            const remoteEntries = listProjectEntries(repositoryPath, defaultRevision, projectIdentity);
            if (localConcerns.length === 0) {
                if (remoteEntries.length > 0) {
                    fail(`${repository} now contains project data; run load before publishing.`);
                }
                console.log(`No ${visibility} workspace data changes to publish.`);
                return;
            }
            if (remoteEntries.length > 0) {
                fail(`#/${visibility} and newly available ${repository} both contain project data without a shared baseline.`);
            }
        }

        const baseRevision = repositoryState.availability === 'available'
            ? repositoryState.baseRevision
            : defaultRevision;
        const patchRevision = createWorkspacePatch(
            repositoryPath,
            baseRevision,
            visibility,
            projectIdentity,
            actor,
            repositoryState.pullRequest && repositoryState.pullRequest.number
        );
        if (!patchRevision) {
            console.log(`No ${visibility} workspace data changes to publish.`);
            return;
        }

        const branchName = `${actor}-contrib/${projectIdentity}`;
        const pushRepository = resolvePushRepository(repository, metadata, actor);
        git(repositoryPath, ['remote', 'add', 'publication', `https://github.com/${pushRepository}.git`]);
        const publicationBranch = readPublicationBranch(pushRepository, branchName);
        let pullRequest = findOpenPullRequest(repository, actor, branchName);

        const branchPreparation = preparePublicationBranch(repositoryPath, {
            actor,
            branchName,
            defaultBranch: metadata.default_branch,
            defaultRevision,
            patchRevision,
            publicationBranch,
            pullRequest,
            visibility
        });

        const pushArguments = ['push'];
        if (branchPreparation.forceLeaseRevision) {
            pushArguments.push(`--force-with-lease=refs/heads/${branchName}:${branchPreparation.forceLeaseRevision}`);
        }
        pushArguments.push('publication', `HEAD:refs/heads/${branchName}`);
        git(repositoryPath, pushArguments);
        if (!pullRequest) {
            const title = `Update workspace data for ${projectIdentity}`;
            const body = `Synchronizes all changed ${visibility} concerns for \`${projectIdentity}\`.`;
            run('gh', [
                'pr', 'create', '--repo', repository, '--base', metadata.default_branch,
                '--head', `${actor}:${branchName}`, '--title', title, '--body', body
            ]);
            pullRequest = findOpenPullRequest(repository, actor, branchName);
        }
        if (!pullRequest) {
            fail(`The ${visibility} publication branch was pushed, but its pull request could not be verified.`);
        }

        const headRevision = git(repositoryPath, ['rev-parse', 'HEAD']).stdout.trim();
        const stagedRoot = path.join(temporaryRoot, 'materialized');
        materializeVisibility(repositoryPath, 'HEAD', projectIdentity, path.join(stagedRoot, visibility));
        state.repositories[visibility] = {
            availability: 'available',
            defaultBranch: metadata.default_branch,
            baseRevision: headRevision,
            complete: true,
            pullRequest: {
                number: pullRequest.number,
                url: pullRequest.url,
                headRepository: pushRepository,
                headBranch: branchName,
                baseBranch: metadata.default_branch,
                status: 'open'
            }
        };
        replaceWorkspace(stagedRoot, state, [visibility]);
        console.log(`Published ${visibility} changes for review: ${pullRequest.url}`);
        return {
            visibility,
            repository,
            repositoryOwner: metadata.owner.login,
            pushRepository,
            headRevision,
            pullRequest: state.repositories[visibility].pullRequest
        };
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

// Publish all changed concerns and optionally merge actor-owned PRs before refreshing the workspace.
function publishAll(projectIdentity, actor, options = {}) {
    const state = readState(projectIdentity, true);
    verifyNamespaceShape(true);
    const publications = [];

    // Keep visibility histories, branches, commits, and pull requests strictly separate.
    for (const visibility of Object.keys(dataRepositories)) {
        const publication = publishVisibility(state, visibility, projectIdentity, actor);
        if (publication) {
            publications.push(publication);
        }
    }

    // Preserve review-first publication unless the caller explicitly selects owned-repository merging.
    if (options.mergeOwned) {
        completeOwnedPublicationCycle(
            publications,
            actor,
            () => loadAll(projectIdentity, actor)
        );
    }
}

// Print the stable user-facing contract without requiring a current Git repository.
function printHelp() {
    console.log(`Usage: gh workspace-data <command>

Commands:
  init                    Reserve the generated # workspace namespace
  load                    Load or reconcile all matched public and private concerns
  publish                 Publish all workspace changes through contribution branches and PRs
  publish --merge-owned   Merge actor-owned PRs and reload after successful immediate merges

Environment overrides:
  WORKSPACE_DATA_PUBLIC_REPOSITORY=owner/repository
  WORKSPACE_DATA_PRIVATE_REPOSITORY=owner/repository`);
}

// Add the root-only generated namespace exclusion while preserving existing ignore content.
function ensureIgnoreExclusion(ignorePath, createWhenMissing) {
    if (!fs.existsSync(ignorePath) && !createWhenMissing) {
        return false;
    }
    if (fs.existsSync(ignorePath)) {
        const stat = fs.lstatSync(ignorePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            fail(`Ignore policy is not an ordinary file: ${ignorePath}`);
        }
    }

    const original = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
    const equivalentPatterns = new Set(['/#/', '/#', '\\#/', '\\#']);
    if (original.split(/\r?\n/).some((line) => equivalentPatterns.has(line.trim()))) {
        return false;
    }

    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const separator = original
        ? (original.endsWith('\n') ? newline : `${newline}${newline}`)
        : '';
    fs.writeFileSync(
        ignorePath,
        `${original}${separator}# Materialized workspace data is generated state.${newline}/#/${newline}`
    );
    return true;
}

// Enforce Git exclusion and augment npm exclusion only when the project already uses it.
function ensureIgnorePolicy(root = projectRoot) {
    const gitignorePath = path.join(root, '.gitignore');
    const npmignorePath = path.join(root, '.npmignore');
    ensureIgnoreExclusion(gitignorePath, true);
    ensureIgnoreExclusion(npmignorePath, false);
}

// Reserve the generated namespace without modifying the canonical project's command surface.
function initializeProject() {
    ensureIgnorePolicy();
    console.log(`Initialized workspace data for ${deriveProjectIdentity()}.`);
    console.log(`Public source:  ${dataRepositories.public}`);
    console.log(`Private source: ${dataRepositories.private}`);
}

// Route complete-data actions without concern-level maintenance arguments.
function main() {
    const [command, ...extraArguments] = process.argv.slice(2);
    if (['help', '--help', '-h'].includes(command) && extraArguments.length === 0) {
        printHelp();
        return;
    }
    const mergeOwned = command === 'publish'
        && extraArguments.length === 1
        && extraArguments[0] === '--merge-owned';
    if (!['init', 'load', 'publish'].includes(command)
        || (extraArguments.length > 0 && !mergeOwned)) {
        fail('Usage: gh workspace-data <init|load|publish [--merge-owned]>');
    }

    projectRoot = establishProjectRoot();
    namespaceRoot = path.join(projectRoot, '#');
    statePath = path.join(namespaceRoot, '.data-state.json');
    const projectIdentity = deriveProjectIdentity();
    const actor = ghApi('user').login;
    if (!actor || !/^[A-Za-z0-9-]+$/.test(actor)) {
        fail('The authenticated GitHub contributor identity is unavailable.');
    }
    dataRepositories = deriveDataRepositories(projectIdentity, actor);

    if (command === 'init') {
        initializeProject();
    } else {
        ensureIgnorePolicy();
        if (command === 'load') {
            loadAll(projectIdentity, actor);
        } else {
            publishAll(projectIdentity, actor, { mergeOwned });
        }
    }
}

// Convert operational failures into a concise nonzero command result.
function execute() {
    try {
        main();
    } catch (error) {
        console.error(`workspace-data: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    completeOwnedPublicationCycle,
    execute,
    ensureIgnorePolicy,
    mergeOwnedPublications,
    preparePublicationBranch,
    replaceWorkspace
};
