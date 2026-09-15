// Verify loading replaces unpublished local data with the selected remote snapshot.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { configureWorkspacePaths, inspectWorkspaceStatus, loadAll } = require('../src/index.js');

const projectIdentity = 'github.com/acme/widget';

// Execute Git in an isolated repository and expose unexpected failures.
function git(repository, args) {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

// Replace a locally modified visibility without creating or applying a reconciliation commit.
test('load overwrites local changes with remote data', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-load-overwrite-'));
    const dataRepository = path.join(root, 'public-data');
    const projectRoot = path.join(root, 'project');
    const sourceRoot = path.join(dataRepository, 'tests', 'github.com', 'acme', 'widget');
    const localRoot = path.join(projectRoot, '#', 'public', 'tests');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.mkdirSync(sourceRoot, { recursive: true });
    git(dataRepository, ['init', '-b', 'main']);
    git(dataRepository, ['config', 'user.name', 'Test']);
    git(dataRepository, ['config', 'user.email', 'test@example.invalid']);
    git(dataRepository, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(sourceRoot, 'data.txt'), 'remote\n');
    git(dataRepository, ['add', '-A', '--', '.']);
    git(dataRepository, ['commit', '-m', 'Add remote data']);
    const revision = git(dataRepository, ['rev-parse', 'HEAD']);
    git(dataRepository, ['update-ref', 'refs/remotes/origin/main', revision]);
    fs.writeFileSync(path.join(sourceRoot, 'data.txt'), 'unselected working tree\n');
    git(dataRepository, ['add', '-A', '--', '.']);
    git(dataRepository, ['commit', '-m', 'Advance local checkout only']);

    fs.mkdirSync(localRoot, { recursive: true });
    fs.writeFileSync(path.join(localRoot, 'data.txt'), 'unpublished local edit\n');
    fs.writeFileSync(path.join(localRoot, 'local-only.txt'), 'unpublished addition\n');
    fs.writeFileSync(path.join(projectRoot, '#', '.data-state.json'), `${JSON.stringify({
        version: 1,
        projectIdentity,
        repositories: {
            public: { availability: 'available', baseRevision: 'a'.repeat(40), complete: true, pullRequest: null },
            private: { availability: 'missing', complete: true, pullRequest: null }
        }
    })}\n`);
    configureWorkspacePaths(projectRoot);

    loadAll(projectIdentity, {
        dataRepositories: { public: 'acme/public-data', private: 'alice/private-data' },
        readRepositoryMetadata: (repository) => repository === 'acme/public-data'
            ? { default_branch: 'main' }
            : null,
        cloneRepository: () => dataRepository
    });

    assert.equal(fs.readFileSync(path.join(localRoot, 'data.txt'), 'utf8'), 'remote\n');
    assert.equal(fs.existsSync(path.join(localRoot, 'local-only.txt')), false);
    const state = JSON.parse(fs.readFileSync(path.join(projectRoot, '#', '.data-state.json'), 'utf8'));
    assert.equal(state.version, 2);
    assert.equal(state.repositories.public.baseRevision, revision);
    assert.equal(state.repositories.public.baseline.length, 1);
    assert.equal(state.repositories.public.baseline[0].path, 'tests/data.txt');
    assert.equal(state.repositories.public.baseline[0].sourcePath, `tests/${projectIdentity}/data.txt`);
    assert.equal(state.repositories.public.baseline[0].digest,
        `sha256:${crypto.createHash('sha256').update('remote\n').digest('hex')}`);
    assert.deepEqual(inspectWorkspaceStatus(projectIdentity).changes, []);
});
