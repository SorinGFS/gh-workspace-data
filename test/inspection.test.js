// Verify the versioned read-only inspection protocol with isolated repositories and authenticated-content stubs.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
    configureWorkspacePaths,
    readBaselineBytes
} = require('../src/index.js');

const executable = path.resolve(__dirname, '..', 'gh-workspace-data');
const projectIdentity = 'github.com/acme/widget';

// Execute Git in one isolated repository and expose unexpected command failures.
function git(repository, args) {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

// Produce the content digest persisted in a version-two baseline entry.
function digest(content) {
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

// Create a canonical target repository whose origin establishes the protocol identity.
function createProject(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-inspection-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, ['init', '-b', 'main']);
    git(root, ['remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
    return root;
}

// Build one validated baseline entry for a public tests concern.
function baselineEntry(dataPath, content, objectCharacter) {
    return {
        path: dataPath,
        sourcePath: `tests/${projectIdentity}/${dataPath.slice('tests/'.length)}`,
        object: objectCharacter.repeat(40),
        digest: digest(content),
        size: Buffer.byteLength(content),
        mode: '100644'
    };
}

// Persist complete version-two state with an empty private baseline.
function writeState(root, publicBaseline) {
    const namespaceRoot = path.join(root, '#');
    fs.mkdirSync(namespaceRoot, { recursive: true });
    const state = {
        version: 2,
        projectIdentity,
        repositories: {
            public: {
                availability: 'available',
                repository: 'acme/public-data',
                baselineRepository: 'acme/public-data',
                defaultBranch: 'main',
                baseRevision: 'a'.repeat(40),
                baseline: publicBaseline,
                complete: true,
                pullRequest: null
            },
            private: {
                availability: 'missing',
                repository: 'alice/private-data',
                baselineRepository: null,
                baseline: [],
                complete: true,
                pullRequest: null
            }
        }
    };
    fs.writeFileSync(path.join(namespaceRoot, '.data-state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

// Run the extension entry point and retain binary stdout for raw-content checks.
function runCommand(root, args, options = {}) {
    return spawnSync(process.execPath, [executable, ...args], {
        cwd: root,
        env: options.env || process.env,
        encoding: options.encoding === undefined ? 'utf8' : options.encoding
    });
}

// Report deterministic additions, modifications, and deletions without contacting GitHub.
test('reports workspace changes against a version-two loaded baseline', (context) => {
    const root = createProject(context);
    const publicRoot = path.join(root, '#', 'public', 'tests');
    const privateRoot = path.join(root, '#', 'private', 'notes');
    fs.mkdirSync(publicRoot, { recursive: true });
    fs.mkdirSync(privateRoot, { recursive: true });
    fs.writeFileSync(path.join(publicRoot, 'added.txt'), 'added\n');
    fs.writeFileSync(path.join(publicRoot, 'modified.txt'), 'workspace\n');
    fs.writeFileSync(path.join(privateRoot, 'local.txt'), 'private\n');
    writeState(root, [
        baselineEntry('tests/deleted.txt', 'deleted\n', 'b'),
        baselineEntry('tests/modified.txt', 'baseline\n', 'c')
    ]);

    const before = fs.readFileSync(path.join(root, '#', '.data-state.json'));
    const result = runCommand(root, ['status', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.protocolVersion, 1);
    assert.equal(report.projectIdentity, projectIdentity);
    assert.equal(report.state, 'ready');
    assert.deepEqual(report.changes.map(({ id, status }) => ({ id, status })), [
        { id: 'public:tests/added.txt', status: 'added' },
        { id: 'public:tests/deleted.txt', status: 'deleted' },
        { id: 'public:tests/modified.txt', status: 'modified' },
        { id: 'private:notes/local.txt', status: 'added' }
    ]);
    assert.deepEqual(fs.readFileSync(path.join(root, '#', '.data-state.json')), before);
    assert.equal(fs.existsSync(path.join(root, '#', 'version-layers.js')), false);
});

// Return a machine-readable initialization state without creating the generated namespace.
test('reports an uninitialized workspace without modifying it', (context) => {
    const root = createProject(context);
    const result = runCommand(root, ['status', '--json']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        protocolVersion: 1,
        projectIdentity,
        state: 'notInitialized',
        repositories: {},
        changes: []
    });
    assert.equal(fs.existsSync(path.join(root, '#')), false);
});

// Require one successful load before a legacy state can provide efficient local inspection.
test('reports reloadRequired for version-one synchronization state', (context) => {
    const root = createProject(context);
    fs.mkdirSync(path.join(root, '#'));
    fs.writeFileSync(path.join(root, '#', '.data-state.json'), JSON.stringify({
        version: 1,
        projectIdentity,
        repositories: {
            public: { availability: 'missing', complete: true, pullRequest: null },
            private: { availability: 'missing', complete: true, pullRequest: null }
        }
    }));

    const result = runCommand(root, ['status', '--json']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, 'reloadRequired');
});

// Emit and verify raw baseline bytes selected through recorded state only.
test('shows one verified loaded baseline file as raw bytes', (context) => {
    const root = createProject(context);
    const content = Buffer.from([0, 1, 2, 10, 255]);
    writeState(root, [baselineEntry('tests/binary.dat', content, 'd')]);
    configureWorkspacePaths(root);

    const result = readBaselineBytes(
        projectIdentity,
        'public',
        'tests/binary.dat',
        'a'.repeat(40),
        () => content
    );

    assert.deepEqual(result, content);
});

// Reject content that does not match the immutable recorded digest.
test('rejects unverifiable baseline content', (context) => {
    const root = createProject(context);
    writeState(root, [baselineEntry('tests/file.txt', 'expected\n', 'e')]);
    configureWorkspacePaths(root);

    assert.throws(() => readBaselineBytes(
        projectIdentity,
        'public',
        'tests/file.txt',
        'a'.repeat(40),
        () => Buffer.from('tampered\n')
    ), /Baseline content verification failed/);
});

// Reject a stale virtual-document revision before any baseline network retrieval.
test('rejects a baseline revision that is no longer loaded', (context) => {
    const root = createProject(context);
    writeState(root, [baselineEntry('tests/file.txt', 'expected\n', 'f')]);
    configureWorkspacePaths(root);

    assert.throws(() => readBaselineBytes(
        projectIdentity,
        'public',
        'tests/file.txt',
        'b'.repeat(40),
        () => assert.fail('a stale baseline must not be fetched')
    ), /baseline revision is no longer loaded/);
});
