'use strict';
// Verify extension-owned runtime support remains ordinary, deterministic, and separate from visibility data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureRuntimeSupport, replaceWorkspace, verifyNamespaceShape } = require('../src/index.js');

const sourcePath = path.resolve(__dirname, '..', 'src', 'version-layers.js');

// Install, retain, and refresh the generated helper from its canonical extension source.
test('materializes runtime support idempotently and refreshes stale content', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-runtime-'));
    const namespaceRoot = path.join(root, '#');
    const target = path.join(namespaceRoot, 'version-layers.js');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    assert.equal(ensureRuntimeSupport(namespaceRoot), true);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(sourcePath));
    assert.equal(ensureRuntimeSupport(namespaceRoot), false);
    fs.writeFileSync(target, 'stale runtime support\n');
    assert.equal(ensureRuntimeSupport(namespaceRoot), true);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(sourcePath));
});

// Reject a directory where the generated ordinary runtime file must reside.
test('rejects a non-file runtime support target', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-runtime-directory-'));
    const namespaceRoot = path.join(root, '#');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(namespaceRoot, 'version-layers.js'), { recursive: true });

    assert.throws(() => ensureRuntimeSupport(namespaceRoot), /version-layers\.js must be an ordinary file/);
});

// Reject a filesystem link without following it or changing its ordinary temporary target.
test('rejects a linked runtime support target', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-runtime-link-'));
    const namespaceRoot = path.join(root, '#');
    const payload = path.join(root, 'payload.js');
    const target = path.join(namespaceRoot, 'version-layers.js');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(namespaceRoot);
    fs.writeFileSync(payload, 'temporary payload\n');
    try {
        fs.symlinkSync(payload, target, 'file');
    } catch (error) {
        if (['EACCES', 'EPERM'].includes(error.code)) {
            context.skip('The runtime does not permit creating a temporary file link.');
            return;
        }
        throw error;
    }

    assert.throws(() => ensureRuntimeSupport(namespaceRoot), /version-layers\.js must be an ordinary file/);
    assert.equal(fs.readFileSync(payload, 'utf8'), 'temporary payload\n');
});

// Permit a generated helper without synchronization state while retaining unknown-root rejection.
test('accepts a helper-only namespace and rejects unknown root content', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-runtime-shape-'));
    const namespaceRoot = path.join(root, '#');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    ensureRuntimeSupport(namespaceRoot);

    assert.doesNotThrow(() => verifyNamespaceShape(false, namespaceRoot));
    fs.writeFileSync(path.join(namespaceRoot, 'unknown.txt'), 'unknown\n');
    assert.throws(() => verifyNamespaceShape(false, namespaceRoot), /Unrecognized generated data path/);
});

// Preserve the sibling runtime helper while replacing a selected visibility snapshot.
test('preserves runtime support during workspace replacement', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-runtime-replacement-'));
    const namespaceRoot = path.join(root, '#');
    const current = path.join(namespaceRoot, 'public');
    const stagedRoot = path.join(root, 'staged');
    const statePath = path.join(namespaceRoot, '.data-state.json');
    const supportPath = path.join(namespaceRoot, 'version-layers.js');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    ensureRuntimeSupport(namespaceRoot);
    fs.mkdirSync(current);
    fs.mkdirSync(path.join(stagedRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(current, 'data.txt'), 'original\n');
    fs.writeFileSync(path.join(stagedRoot, 'public', 'data.txt'), 'replacement\n');

    replaceWorkspace(stagedRoot, { version: 1 }, ['public'], { namespaceRoot, statePath });

    assert.deepEqual(fs.readFileSync(supportPath), fs.readFileSync(sourcePath));
    assert.equal(fs.readFileSync(path.join(current, 'data.txt'), 'utf8'), 'replacement\n');
    assert.deepEqual(fs.readdirSync(namespaceRoot).sort(), ['.data-state.json', 'public', 'version-layers.js']);
});
