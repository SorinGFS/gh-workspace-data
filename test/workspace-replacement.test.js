// Verify failed workspace replacement preserves the complete previous snapshot.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { replaceWorkspace } = require('../src/index.js');

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
        }),
        { code: 'EPERM' }
    );
    assert.equal(fs.readFileSync(path.join(current, 'data.txt'), 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(statePath, 'utf8'), previousState);
    assert.deepEqual(fs.readdirSync(namespaceRoot).sort(), ['.data-state.json', 'public']);
});
