// Verify command routing that does not require GitHub authentication or a target repository.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { ensureIgnorePolicy } = require('../src/index.js');

const executable = path.resolve(__dirname, '..', 'gh-workspace-data');

// Confirm the installed command exposes its stable action and override contract.
test('prints help outside a Git repository', () => {
  const result = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /gh workspace-data <command>/);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /load/);
  assert.match(result.stdout, /publish/);
  assert.match(result.stdout, /WORKSPACE_DATA_PUBLIC_REPOSITORY/);
});

// Reject unknown actions before any repository or remote operation can occur.
test('rejects an unknown command', () => {
  const result = spawnSync(process.execPath, [executable, 'unknown'], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: gh workspace-data <init\|load\|publish>/);
});

// Create the mandatory Git exclusion without introducing an npm policy file.
test('creates only a missing .gitignore and remains idempotent', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-ignore-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  ensureIgnorePolicy(root);
  ensureIgnorePolicy(root);

  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.equal(gitignore.split(/\r?\n/).filter((line) => line === '/#/').length, 1);
  assert.equal(fs.existsSync(path.join(root, '.npmignore')), false);
});

// Extend an existing npm policy without replacing its rules or newline convention.
test('adds the root exclusion to an existing .npmignore', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-npmignore-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.npmignore'), 'dist/\r\n');

  ensureIgnorePolicy(root);
  ensureIgnorePolicy(root);

  const npmignore = fs.readFileSync(path.join(root, '.npmignore'), 'utf8');
  assert.match(npmignore, /^dist\/\r\n/);
  assert.equal(npmignore.split(/\r?\n/).filter((line) => line === '/#/').length, 1);
  assert.equal(npmignore.includes('\r\n/#/\r\n'), true);
});

// Anchor the reserved namespace without excluding legitimate nested # directories.
test('ignores only the root # directory', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-data-root-ignore-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['-C', root, 'init', '-b', 'main']).status, 0);
  ensureIgnorePolicy(root);

  const rootResult = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--', '#/generated.txt']);
  const nestedResult = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--', 'folder/#/legitimate.txt']);

  assert.equal(rootResult.status, 0);
  assert.equal(nestedResult.status, 1);
});
