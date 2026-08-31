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

module.exports = {
    compareNames,
    compareNumericNames,
    discoverVersionLayers,
    readDirectories,
    versionPattern,
};
