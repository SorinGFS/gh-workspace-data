// Verify command routing that does not require GitHub authentication or a target repository.
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

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
