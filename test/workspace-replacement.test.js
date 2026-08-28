// Verify failed workspace replacement preserves the complete previous snapshot.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { establishProjectRoot, replaceWorkspace } = require('../src/index.js');

// Release the invocation directory before replacing the visibility that contains it.
test('replaces a visibility when invoked from inside that visibility', (context) => {
    const originalCwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-nested-invocation-'));
    const namespaceRoot = path.join(root, '#');
    const current = path.join(namespaceRoot, 'private');
    const nestedInvocation = path.join(current, 'scripts');
    const stagedRoot = path.join(root, 'staged');
    const statePath = path.join(namespaceRoot, '.data-state.json');
    context.after(() => {
        process.chdir(originalCwd);
        fs.rmSync(root, { recursive: true, force: true });
    });

    assert.equal(spawnSync('git', ['-C', root, 'init', '-b', 'main']).status, 0);
    fs.mkdirSync(nestedInvocation, { recursive: true });
    fs.mkdirSync(path.join(stagedRoot, 'private'), { recursive: true });
    fs.writeFileSync(path.join(current, 'data.txt'), 'original\n');
    fs.writeFileSync(path.join(stagedRoot, 'private', 'data.txt'), 'replacement\n');
    fs.writeFileSync(statePath, '{"version":1}\n');
    process.chdir(nestedInvocation);

    const establishedRoot = establishProjectRoot();
    assert.equal(fs.realpathSync.native(establishedRoot), fs.realpathSync.native(root));
    assert.equal(fs.realpathSync.native(process.cwd()), fs.realpathSync.native(root));
    replaceWorkspace(stagedRoot, { version: 2 }, ['private'], { namespaceRoot, statePath });

    assert.equal(fs.readFileSync(path.join(current, 'data.txt'), 'utf8'), 'replacement\n');
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{\n  "version": 2\n}\n');
    assert.deepEqual(fs.readdirSync(namespaceRoot).sort(), ['.data-state.json', 'private']);
});

// Retain an unchanged visibility root while advancing its synchronization state.
test('skips directory rotation for an unchanged snapshot', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-unchanged-'));
    const namespaceRoot = path.join(root, '#');
    const stagedRoot = path.join(root, 'staged');
    const current = path.join(namespaceRoot, 'private');
    const statePath = path.join(namespaceRoot, '.data-state.json');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.mkdirSync(path.join(current, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(stagedRoot, 'private', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(current, 'scripts', 'data.txt'), 'unchanged\n');
    fs.writeFileSync(path.join(stagedRoot, 'private', 'scripts', 'data.txt'), 'unchanged\n');

    replaceWorkspace(stagedRoot, { version: 2 }, ['private'], {
        namespaceRoot,
        statePath,
        renameSync: () => assert.fail('unchanged snapshots must not be renamed'),
    });

    assert.equal(fs.readFileSync(path.join(current, 'scripts', 'data.txt'), 'utf8'), 'unchanged\n');
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{\n  "version": 2\n}\n');
    assert.deepEqual(fs.readdirSync(namespaceRoot).sort(), ['.data-state.json', 'private']);
});

// Complete replacement after bounded retries outlast a transient Windows sharing violation.
test('retries a transient backup rename failure', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-rename-retry-'));
    const namespaceRoot = path.join(root, '#');
    const stagedRoot = path.join(root, 'staged');
    const current = path.join(namespaceRoot, 'private');
    const statePath = path.join(namespaceRoot, '.data-state.json');
    const waits = [];
    let attempts = 0;
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(path.join(stagedRoot, 'private'), { recursive: true });
    fs.writeFileSync(path.join(current, 'data.txt'), 'original\n');
    fs.writeFileSync(path.join(stagedRoot, 'private', 'data.txt'), 'replacement\n');

    // Model a scanner releasing the current visibility after two sharing violations.
    function transientBackupRename(source, destination) {
        if (source === current && path.basename(destination).startsWith('.backup-') && attempts < 2) {
            attempts += 1;
            const error = new Error('operation not permitted');
            error.code = 'EPERM';
            throw error;
        }
        fs.renameSync(source, destination);
    }

    replaceWorkspace(stagedRoot, { version: 2 }, ['private'], {
        namespaceRoot,
        statePath,
        renameSync: transientBackupRename,
        maxRenameRetries: 2,
        renameRetryDelay: 10,
        waitForRenameRetry: (milliseconds) => waits.push(milliseconds),
    });

    assert.equal(attempts, 2);
    assert.deepEqual(waits, [10, 20]);
    assert.equal(fs.readFileSync(path.join(current, 'data.txt'), 'utf8'), 'replacement\n');
    assert.equal(fs.readFileSync(statePath, 'utf8'), '{\n  "version": 2\n}\n');
    assert.deepEqual(fs.readdirSync(namespaceRoot).sort(), ['.data-state.json', 'private']);
});

// Preserve the original visibility when Windows rejects the initial backup rename.
test('keeps the current snapshot when its backup rename fails', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-replacement-'));
    const namespaceRoot = path.join(root, '#');
    const stagedRoot = path.join(root, 'staged');
    const current = path.join(namespaceRoot, 'public');
    const statePath = path.join(namespaceRoot, '.data-state.json');
    const previousState = '{"version":1}\n';
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(path.join(stagedRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(current, 'data.txt'), 'original\n');
    fs.writeFileSync(path.join(stagedRoot, 'public', 'data.txt'), 'replacement\n');
    fs.writeFileSync(statePath, previousState);

    // Reproduce the observed EPERM only for the first current-to-backup transition.
    function rejectBackupRename(source, destination) {
        if (source === current && path.basename(destination).startsWith('.backup-')) {
            const error = new Error('operation not permitted');
            error.code = 'EPERM';
            throw error;
        }
        fs.renameSync(source, destination);
    }

    assert.throws(
        () => replaceWorkspace(stagedRoot, { version: 2 }, ['public'], {
            namespaceRoot,
            statePath,
            renameSync: rejectBackupRename,
            maxRenameRetries: 0,
        }),
        { code: 'EPERM' }
    );
    assert.equal(fs.readFileSync(path.join(current, 'data.txt'), 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(statePath, 'utf8'), previousState);
    assert.deepEqual(fs.readdirSync(namespaceRoot).sort(), ['.data-state.json', 'public']);
});
