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
