import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWorkingTreeClean,
  currentBranchExists,
  currentRef,
  createMigrationBranch,
  runEslintMigration,
  runPrettierMigration,
  stageAll,
  stagedStat,
  commitMigration,
  rollbackMigration,
  MIGRATION_BRANCH,
  COMMIT_MESSAGE,
} from '../src/migrate.js';

function fakeExec(responses = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const response = responses[[cmd, ...args].join(' ')];
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

  test('false when only untracked files exist', () => {
    const exec = fakeExec({ 'git status --porcelain': '?? scratch.txt\n' });
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

describe('currentRef', () => {
  test('returns the branch name on a normal checkout', () => {
    const exec = fakeExec({ 'git rev-parse --abbrev-ref HEAD': 'main\n' });
    assert.equal(currentRef('/repo', exec), 'main');
  });

  test('falls back to the commit hash on a detached HEAD', () => {
    const exec = fakeExec({
      'git rev-parse --abbrev-ref HEAD': 'HEAD\n',
      'git rev-parse HEAD': 'abc123\n',
    });
    assert.equal(currentRef('/repo', exec), 'abc123');
  });
});

describe('migration step runners', () => {
  test('createMigrationBranch checks out the expected branch name', () => {
    const exec = fakeExec();
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
});

describe('reviewing and committing', () => {
  test('stageAll stages everything, including untracked files', () => {
    const exec = fakeExec();
    stageAll('/repo', exec);
    assert.deepEqual(exec.calls, [['git', 'add', '-A']]);
  });

  test('stagedStat reads the cached diff, so new files are visible', () => {
    // `git diff --stat` (unstaged) would print nothing for brand-new files.
    const exec = fakeExec({ 'git diff --cached --stat': ' .oxlintrc.json | 60 ++++\n' });
    assert.equal(stagedStat('/repo', exec), ' .oxlintrc.json | 60 ++++\n');
    assert.deepEqual(exec.calls, [['git', 'diff', '--cached', '--stat']]);
  });

  test('commitMigration only commits — staging is a separate, earlier step', () => {
    const exec = fakeExec();
    commitMigration('/repo', exec);
    assert.deepEqual(exec.calls, [['git', 'commit', '-m', COMMIT_MESSAGE]]);
  });
});

describe('rollbackMigration', () => {
  test('stages, hard-resets, returns to the original ref, then deletes the branch — in that order', () => {
    const exec = fakeExec();
    rollbackMigration('/repo', 'main', exec);
    assert.deepEqual(exec.calls, [
      ['git', 'add', '-A'],
      ['git', 'reset', '--hard', 'HEAD'],
      ['git', 'checkout', 'main'],
      ['git', 'branch', '-D', MIGRATION_BRANCH],
    ]);
  });

  test('propagates a failure so the caller can print manual cleanup steps', () => {
    const exec = fakeExec({ 'git checkout main': new Error('checkout failed') });
    assert.throws(() => rollbackMigration('/repo', 'main', exec), /checkout failed/);
  });
});