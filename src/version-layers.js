'use strict';
// Provide deterministic directory ordering and package-version layer selection to materialized workspace tools.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const versionPattern = /^v(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?$/;

// Compare directory and file names without locale-dependent ordering.
const compareNames = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

// Compare numeric directory or JSON fixture names without integer-size or leading-zero ambiguity.
const compareNumericNames = (left, right) => {
    const leftNumber = BigInt(left.name.replace(/\.json$/, ''));
    const rightNumber = BigInt(right.name.replace(/\.json$/, ''));
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    return compareNames(left, right);
};

// Parse a version-layer name into its numeric components.
const parseVersionLayer = (name) => {
    const match = versionPattern.exec(name);
    return match ? match.slice(1).filter((part) => part !== undefined).map(Number) : undefined;
};

// Compare semantic-version layers after treating omitted minor and patch components as zero.
const compareVersions = (left, right) => {
    // Return the first differing component so partial and complete layers remain numerically ordered.
    for (let index = 0; index < 3; index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
};

// Read direct child directories while excluding filesystem links and loose files.
const readDirectories = (root) => fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

// Require an ordered layer collection before traversing its filesystem roots.
const validateLayers = (layers) => {
    assert.ok(Array.isArray(layers), 'Version layers must be an array.');
    for (const layer of layers) {
        assert.ok(layer && typeof layer === 'object', 'Each version layer must be an object.');
        assert.equal(typeof layer.name, 'string', 'Each version layer must have a string name.');
        assert.equal(typeof layer.root, 'string', 'Each version layer must have a string root.');
    }
};

// Select exact-scope layers by default or every compatible earlier layer when requested.
const discoverVersionLayers = (root, packageVersionString, options = {}) => {
    const packageVersionMatch = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/.exec(packageVersionString);
    assert.ok(packageVersionMatch, `Unsupported package version: ${packageVersionString}`);
    assert.ok(options && typeof options === 'object', 'Version-layer options must be an object.');
    const backwardsCompatible = options.backwardsCompatible ?? false;
    assert.equal(typeof backwardsCompatible, 'boolean', 'backwardsCompatible must be a boolean.');
    const packageVersion = packageVersionMatch.slice(1, 4).map(Number);
    const versionLayers = new Map();

    // Index every valid version directory before selecting eligible layers.
    for (const entry of readDirectories(root)) {
        const version = parseVersionLayer(entry.name);
        if (version) versionLayers.set(entry.name, { name: entry.name, root: path.join(root, entry.name), version });
    }

    const layers = [{ name: '.', root }];
    if (backwardsCompatible) {
        // Treat partial layers as introduction versions and include every layer not newer than the package.
        const compatibleLayers = [...versionLayers.values()]
            .filter((layer) => compareVersions(layer.version, packageVersion) <= 0)
            .sort((left, right) => compareVersions(left.version, right.version)
                || left.version.length - right.version.length
                || compareNames(left, right));
        layers.push(...compatibleLayers);
        return layers;
    }

    const majorLayer = versionLayers.get(`v${packageVersion[0]}`);
    if (majorLayer) layers.push(majorLayer);
    const minorLayer = versionLayers.get(`v${packageVersion[0]}.${packageVersion[1]}`);
    if (minorLayer) layers.push(minorLayer);
    const completeLayers = [...versionLayers.values()]
        .filter((layer) => layer.version.length === 3)
        .filter((layer) => layer.version[0] === packageVersion[0] && compareVersions(layer.version, packageVersion) <= 0)
        .sort((left, right) => compareVersions(left.version, right.version));
    layers.push(...completeLayers);
    return layers;
};

// Return both stable selection policies so one consumer can apply them to different content types.
const discoverVersionLayerSets = (root, packageVersionString) => ({
    exact: discoverVersionLayers(root, packageVersionString),
    cumulative: discoverVersionLayers(root, packageVersionString, { backwardsCompatible: true }),
});

// Choose one discovered policy through the existing backwards-compatible option contract.
const selectVersionLayers = (layerSets, options = {}) => {
    assert.ok(layerSets && typeof layerSets === 'object', 'Version layer sets must be an object.');
    validateLayers(layerSets.exact);
    validateLayers(layerSets.cumulative);
    assert.ok(options && typeof options === 'object', 'Version-layer selection options must be an object.');
    const backwardsCompatible = options.backwardsCompatible ?? false;
    assert.equal(typeof backwardsCompatible, 'boolean', 'backwardsCompatible must be a boolean.');
    return backwardsCompatible ? layerSets.cumulative : layerSets.exact;
};

// Flatten numeric collections into independently addressable JSON fixtures in deterministic order.
const discoverNumberedJsonFixtures = (layers) => {
    validateLayers(layers);
    const fixtures = [];

    // Preserve caller-supplied semantic layer order before numeric collection and filename order.
    for (const layer of layers) {
        const numericDirectories = readDirectories(layer.root)
            .filter((entry) => /^\d+$/.test(entry.name))
            .sort(compareNumericNames);

        // Require every discovered numeric collection to contain at least one numbered JSON fixture.
        for (const directory of numericDirectories) {
            const collectionRoot = path.join(layer.root, directory.name);
            const fixtureFiles = fs.readdirSync(collectionRoot, { withFileTypes: true })
                .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
                .sort(compareNumericNames);
            assert.ok(fixtureFiles.length > 0, `${layer.name}/${directory.name} contains no numbered JSON fixtures.`);

            // Retain filesystem and portable source identifiers without interpreting fixture contents.
            for (const fixtureFile of fixtureFiles) {
                const prefix = layer.name === '.' ? '' : `${layer.name}/`;
                fixtures.push({
                    layer: layer.name,
                    collection: directory.name,
                    file: fixtureFile.name,
                    id: `${prefix}${directory.name}/${fixtureFile.name}`,
                    path: path.join(collectionRoot, fixtureFile.name),
                });
            }
        }
    }
    return fixtures;
};

// Find explicit nonnumeric index.js concerns while preserving layer and lexical concern order.
const discoverConcernEntryPoints = (layers) => {
    validateLayers(layers);
    const concerns = [];

    // Keep version selectors and numeric collections outside explicit concern discovery.
    for (const layer of layers) {
        const concernDirectories = readDirectories(layer.root)
            .filter((entry) => !/^\d+$/.test(entry.name) && !versionPattern.test(entry.name))
            .filter((entry) => {
                const entryPoint = path.join(layer.root, entry.name, 'index.js');
                return fs.existsSync(entryPoint) && fs.lstatSync(entryPoint).isFile();
            })
            .sort(compareNames);

        // Return descriptors rather than loading entry points so consumers retain execution control.
        for (const concern of concernDirectories) {
            const prefix = layer.name === '.' ? '' : `${layer.name}/`;
            const root = path.join(layer.root, concern.name);
            concerns.push({
                layer: layer.name,
                concern: concern.name,
                id: `${prefix}${concern.name}`,
                root,
                entryPoint: path.join(root, 'index.js'),
            });
        }
    }
    return concerns;
};

module.exports = {
    compareNames,
    compareNumericNames,
    discoverConcernEntryPoints,
    discoverNumberedJsonFixtures,
    discoverVersionLayers,
    discoverVersionLayerSets,
    readDirectories,
    selectVersionLayers,
    versionPattern,
};
