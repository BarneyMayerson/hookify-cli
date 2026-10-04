import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWorkingTreeClean,
  currentBranchExists,
  createMigrationBranch,
  runEslintMigration,
  runPrettierMigration,
  diffStat,
  commitMigration,
  MIGRATION_BRANCH,
} from '../src/migrate.js';

function fakeExec(responses) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    const response = responses[key];
    if (response instanceof Error) throw response;
    return response ?? '';
  };
  exec.calls = calls;
  return exec;
}

describe('isWorkingTreeClean', () => {
  test('true when git status --porcelain is empty', () => {
    const exec = fakeExec({ 'git status --porcelain': '' });
    assert.equal(isWorkingTreeClean('/repo', exec), true);
  });

  test('false when there are uncommitted changes', () => {
    const exec = fakeExec({ 'git status --porcelain': ' M file.js\n' });
    assert.equal(isWorkingTreeClean('/repo', exec), false);
  });
});

describe('currentBranchExists', () => {
  test('true when rev-parse succeeds', () => {
    const exec = fakeExec({ [`git rev-parse --verify ${MIGRATION_BRANCH}`]: '' });
    assert.equal(currentBranchExists('/repo', MIGRATION_BRANCH, exec), true);
  });

  test('false when rev-parse throws (branch does not exist)', () => {
    const exec = fakeExec({
      [`git rev-parse --verify ${MIGRATION_BRANCH}`]: new Error('not found'),
    });
    assert.equal(currentBranchExists('/repo', MIGRATION_BRANCH, exec), false);
  });
});

describe('migration step runners', () => {
  test('createMigrationBranch checks out the expected branch name', () => {
    const exec = fakeExec({});
    createMigrationBranch('/repo', exec);
    assert.deepEqual(exec.calls, [['git', 'checkout', '-b', MIGRATION_BRANCH]]);
  });

  test('runEslintMigration invokes @oxlint/migrate on eslint.config.js', () => {
    const exec = fakeExec({ 'npx --yes @oxlint/migrate eslint.config.js': 'Migrated 42 rules' });
    assert.equal(runEslintMigration('/repo', exec), 'Migrated 42 rules');
  });

  test('runPrettierMigration invokes oxfmt --migrate prettier', () => {
    const exec = fakeExec({
      'npx --yes oxfmt@latest --migrate prettier': 'Wrote .oxfmtrc.json',
    });
    assert.equal(runPrettierMigration('/repo', exec), 'Wrote .oxfmtrc.json');
  });

  test('diffStat returns git diff --stat output', () => {
    const exec = fakeExec({ 'git diff --stat': ' 2 files changed' });
    assert.equal(diffStat('/repo', exec), ' 2 files changed');
  });

  test('commitMigration stages everything then commits with a fixed message', () => {
    const exec = fakeExec({});
    commitMigration('/repo', exec);
    assert.deepEqual(exec.calls, [
      ['git', 'add', '-A'],
      ['git', 'commit', '-m', 'chore: migrate ESLint + Prettier config to OXC (oxlint/oxfmt)'],
    ]);
  });
});