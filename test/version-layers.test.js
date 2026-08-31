'use strict';
// Verify the generated version-layer helper's eligibility and deterministic ordering contract.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    compareNumericNames,
    discoverConcernEntryPoints,
    discoverNumberedJsonFixtures,
    discoverVersionLayers,
    discoverVersionLayerSets,
    selectVersionLayers,
} = require('../src/version-layers.js');

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

// Provide exact and cumulative sets together for consumers with mixed traversal policies.
test('discovers both version-layer selection policies', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-layer-sets-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // Include older, matching, and future partial layers to distinguish both policies.
    for (const name of ['v15.1', 'v16.0', 'v17.0', 'v18.0']) {
        fs.mkdirSync(path.join(root, name));
    }

    const layerSets = discoverVersionLayerSets(root, '17.0.2');
    assert.deepEqual(layerSets.exact.map((layer) => layer.name), ['.', 'v17.0']);
    assert.deepEqual(layerSets.cumulative.map((layer) => layer.name), ['.', 'v15.1', 'v16.0', 'v17.0']);
});

// Select one precomputed policy without changing the existing boolean option semantics.
test('selects and validates a discovered version-layer policy', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-layer-selection-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'v1'));

    const layerSets = discoverVersionLayerSets(root, '1.0.0');
    assert.equal(selectVersionLayers(layerSets), layerSets.exact);
    assert.equal(selectVersionLayers(layerSets, { backwardsCompatible: true }), layerSets.cumulative);
    assert.throws(() => selectVersionLayers(null), /sets must be an object/);
    assert.throws(
        () => selectVersionLayers(layerSets, { backwardsCompatible: 'true' }),
        /backwardsCompatible must be a boolean/,
    );
});

// Flatten numbered JSON fixtures while retaining semantic, numeric, and portable source identity.
test('discovers numbered JSON fixtures in deterministic order', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-numbered-fixtures-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const olderRoot = path.join(root, 'v1');
    const newerRoot = path.join(root, 'v2');

    // Deliberately create collections and fixtures outside their required traversal order.
    for (const [layerRoot, collection, files] of [
        [olderRoot, '10', ['10.json', '2.json', 'schema.json']],
        [olderRoot, '2', ['1.json']],
        [newerRoot, '0', ['0.json']],
    ]) {
        fs.mkdirSync(path.join(layerRoot, collection), { recursive: true });
        // Populate each collection with numbered fixtures plus any ignored metadata files.
        for (const file of files) fs.writeFileSync(path.join(layerRoot, collection, file), '{}\n');
    }

    const fixtures = discoverNumberedJsonFixtures([
        { name: 'v1', root: olderRoot },
        { name: 'v2', root: newerRoot },
    ]);
    assert.deepEqual(fixtures.map((fixture) => fixture.id), [
        'v1/2/1.json', 'v1/10/2.json', 'v1/10/10.json', 'v2/0/0.json',
    ]);
    assert.deepEqual(fixtures[0], {
        layer: 'v1',
        collection: '2',
        file: '1.json',
        id: 'v1/2/1.json',
        path: path.join(olderRoot, '2', '1.json'),
    });

    fs.mkdirSync(path.join(newerRoot, '3'));
    assert.throws(
        () => discoverNumberedJsonFixtures([{ name: 'v2', root: newerRoot }]),
        /v2\/3 contains no numbered JSON fixtures/,
    );
});

// Discover only explicit ordinary index.js concerns in lexical order within each supplied layer.
test('discovers explicit concern entry points in deterministic order', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-concerns-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // Include concerns, numeric collections, nested versions, and a directory without an entry point.
    for (const name of ['zeta', 'alpha', 'missing', '0', 'v2']) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, 'zeta', 'index.js'), 'module.exports = () => {};\n');
    fs.writeFileSync(path.join(root, 'alpha', 'index.js'), 'module.exports = () => {};\n');
    fs.writeFileSync(path.join(root, '0', 'index.js'), 'module.exports = () => {};\n');
    fs.writeFileSync(path.join(root, 'v2', 'index.js'), 'module.exports = () => {};\n');

    const concerns = discoverConcernEntryPoints([{ name: '.', root }]);
    assert.deepEqual(concerns.map((concern) => concern.id), ['alpha', 'zeta']);
    assert.deepEqual(concerns[0], {
        layer: '.',
        concern: 'alpha',
        id: 'alpha',
        root: path.join(root, 'alpha'),
        entryPoint: path.join(root, 'alpha', 'index.js'),
    });
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
