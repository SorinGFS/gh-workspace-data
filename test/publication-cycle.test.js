// Verify publication history transitions with isolated Git repositories and no GitHub side effects.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { preparePublicationBranch } = require('../src/index.js');

// Execute Git in one isolated repository and expose unexpected command failures.
function git(repository, args, acceptedStatuses = [0]) {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    if (!acceptedStatuses.includes(result.status)) {
        throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    }
    return result;
}

// Write the complete project data state represented by one test commit.
function writeProjectData(repository, fooContent, barContent = null) {
    const projectRoot = path.join(repository, 'test', 'github.com', 'acme', 'widget');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'foo.json'), fooContent);
    if (barContent === null) {
        fs.rmSync(path.join(projectRoot, 'bar.json'), { force: true });
    } else {
        fs.writeFileSync(path.join(projectRoot, 'bar.json'), barContent);
    }
}

// Commit all staged test data with a deterministic local identity.
function commit(repository, message) {
    git(repository, ['add', '-A', '--', '.']);
    git(repository, ['commit', '-m', message]);
    return git(repository, ['rev-parse', 'HEAD']).stdout.trim();
}

// Preserve edits made after a squash merge even when no load occurs before the next publish.
test('starts a clean publication cycle after merge without an intervening load', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-publication-cycle-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const publication = path.join(root, 'publication');
    const branchName = 'alice-contrib/github.com/acme/widget';

    fs.mkdirSync(seed);
    git(root, ['init', '--bare', remote]);
    git(seed, ['init', '-b', 'main']);
    git(seed, ['config', 'user.name', 'Alice']);
    git(seed, ['config', 'user.email', 'alice@example.invalid']);
    git(seed, ['remote', 'add', 'origin', remote]);
    writeProjectData(seed, '0\n');
    commit(seed, 'Initial data');
    git(seed, ['push', '-u', 'origin', 'main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    git(root, ['clone', '--config', 'core.autocrlf=false', remote, publication]);
    git(publication, ['config', 'user.name', 'Alice']);
    git(publication, ['config', 'user.email', 'alice@example.invalid']);

    // Model the first published PR head, which remains as the stale stable branch.
    git(publication, ['checkout', '-b', branchName, 'origin/main']);
    writeProjectData(publication, '1\n');
    const previousPullRequestHead = commit(publication, 'First publication');
    git(publication, ['push', '-u', 'origin', branchName]);

    // Model GitHub squash-merging the same tree through a distinct commit on main.
    git(publication, ['checkout', 'main']);
    writeProjectData(publication, '1\n');
    const mergedDefault = commit(publication, 'Squash first publication');
    git(publication, ['push', 'origin', 'main']);
    git(publication, ['fetch', 'origin', 'main']);

    // Model additional workspace edits derived from the old PR head without running load.
    git(publication, ['checkout', '--detach', previousPullRequestHead]);
    writeProjectData(publication, '2\n', 'new\n');
    const subsequentPatch = commit(publication, 'Subsequent workspace edits');

    const preparation = preparePublicationBranch(publication, {
        actor: 'alice',
        branchName,
        defaultBranch: 'main',
        defaultRevision: mergedDefault,
        patchRevision: subsequentPatch,
        publicationBranch: { revision: previousPullRequestHead },
        pullRequest: null,
        visibility: 'private'
    });

    const currentHead = git(publication, ['rev-parse', 'HEAD']).stdout.trim();
    assert.equal(preparation.forceLeaseRevision, previousPullRequestHead);
    assert.equal(git(publication, ['rev-list', '--count', `${mergedDefault}..${currentHead}`]).stdout.trim(), '1');
    assert.equal(git(publication, ['merge-base', '--is-ancestor', mergedDefault, currentHead], [0, 1]).status, 0);
    assert.equal(git(publication, ['merge-base', '--is-ancestor', previousPullRequestHead, currentHead], [0, 1]).status, 1);
    assert.equal(fs.readFileSync(path.join(publication, 'test', 'github.com', 'acme', 'widget', 'foo.json'), 'utf8'), '2\n');
    assert.equal(fs.readFileSync(path.join(publication, 'test', 'github.com', 'acme', 'widget', 'bar.json'), 'utf8'), 'new\n');
    assert.equal(git(publication, ['status', '--short']).stdout, '');
});
