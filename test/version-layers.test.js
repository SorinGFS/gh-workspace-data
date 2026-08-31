'use strict';
// Verify the generated version-layer helper's eligibility and deterministic ordering contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareNumericNames, discoverVersionLayers } = require('../src/version-layers.js');

// Select base, exact partial, and eligible complete layers in their required sequence.
test('discovers eligible version layers in deterministic order', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-version-layers-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // Include exact, older, future, different-minor, and different-major selectors.
    for (const name of ['behavior', 'v1', 'v1.0.0', 'v1.1', 'v1.1.3', 'v1.2', 'v1.2.3', 'v1.2.4', 'v2', 'v2.0.0']) {
        fs.mkdirSync(path.join(root, name));
    }

    const layers = discoverVersionLayers(root, '1.2.3');
    assert.deepEqual(layers.map((layer) => layer.name), ['.', 'v1', 'v1.2', 'v1.0.0', 'v1.1.3', 'v1.2.3']);
});

// Include every semantic-version introduction point through the package when compatibility is cumulative.
test('discovers backwards-compatible layers across major versions in semantic order', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-compatible-layers-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // Include older majors, equal partial forms, the exact version, and future selectors.
    for (const name of [
        'v0.9.9', 'v1', 'v1.0', 'v1.0.0', 'v1.1', 'v1.1.2', 'v1.2', 'v1.2.3', 'v1.2.4', 'v2',
    ]) {
        fs.mkdirSync(path.join(root, name));
    }

    const layers = discoverVersionLayers(root, '1.2.3+build', { backwardsCompatible: true });
    assert.deepEqual(layers.map((layer) => layer.name), [
        '.', 'v0.9.9', 'v1', 'v1.0', 'v1.0.0', 'v1.1', 'v1.1.2', 'v1.2', 'v1.2.3',
    ]);
});

// Reject malformed helper options before they can silently alter layer eligibility.
test('validates backwards-compatible discovery options', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-layer-options-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    assert.throws(() => discoverVersionLayers(root, '1.2.3', null), /options must be an object/);
    assert.throws(
        () => discoverVersionLayers(root, '1.2.3', { backwardsCompatible: 'true' }),
        /backwardsCompatible must be a boolean/,
    );
});

// Sort arbitrarily large numeric names numerically and resolve equivalent values lexically.
test('orders numeric directories and fixtures without integer-size ambiguity', () => {
    const entries = [
        { name: '10.json' },
        { name: '2.json' },
        { name: '1.json' },
        { name: '001.json' },
        { name: '90071992547409930.json' },
    ];

    entries.sort(compareNumericNames);
    assert.deepEqual(entries.map((entry) => entry.name), [
        '001.json',
        '1.json',
        '2.json',
        '10.json',
        '90071992547409930.json',
    ]);
});
