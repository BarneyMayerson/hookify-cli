import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isWorkingTreeClean,
  currentBranchExists,
  currentRef,
  createMigrationBranch,
  runEslintMigration,
  runPrettierMigration,
  stageMigrationFiles,
  stagedStat,
  commitMigration,
  rollbackMigration,
  usedOrganizeImports,
  enableSortImports,
  detectPackageManager,
  installCommand,
  missingPackages,
  installOxcPackages,
  formatGeneratedConfigs,
  MIGRATION_FILES,
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
  test('stageMigrationFiles stages only the files migrate may touch — never `git add -A`', () => {
    const dir = tempProject({ '.oxlintrc.json': '{}', '.oxfmtrc.json': '{}', 'package.json': '{}' });
    // check-ignore exits 1 (throws) for files that are NOT ignored.
    const notIgnored = new Error('not ignored');
    const exec = fakeExec({
      'git check-ignore -q -- .oxlintrc.json': notIgnored,
      'git check-ignore -q -- .oxfmtrc.json': notIgnored,
      'git check-ignore -q -- package.json': notIgnored,
    });

    const staged = stageMigrationFiles(dir, exec);

    assert.deepEqual(staged, ['.oxlintrc.json', '.oxfmtrc.json', 'package.json']);
    const addCall = exec.calls.find((c) => c[1] === 'add');
    assert.deepEqual(addCall, ['git', 'add', '--', '.oxlintrc.json', '.oxfmtrc.json', 'package.json']);
    assert.equal(exec.calls.some((c) => c.includes('-A')), false);
  });

  test('stageMigrationFiles skips gitignored files, which `git add` would reject', () => {
    const dir = tempProject({ '.oxlintrc.json': '{}', 'yarn.lock': '' });
    const notIgnored = new Error('not ignored');
    const exec = fakeExec({
      'git check-ignore -q -- .oxlintrc.json': notIgnored,
      // yarn.lock: check-ignore succeeds (exit 0) => it is ignored
    });

    assert.deepEqual(stageMigrationFiles(dir, exec), ['.oxlintrc.json']);
  });

  test('stageMigrationFiles runs no `git add` at all when nothing qualifies', () => {
    const exec = fakeExec();
    assert.deepEqual(stageMigrationFiles(tempProject(), exec), []);
    assert.equal(exec.calls.some((c) => c[1] === 'add'), false);
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
  test('resets tracked files, cleans only the migration paths, returns to the original ref, deletes the branch — in order', () => {
    const exec = fakeExec();
    rollbackMigration('/repo', 'main', exec);
    assert.deepEqual(exec.calls, [
      ['git', 'reset', '--hard', 'HEAD'],
      ['git', 'clean', '-f', '--', ...MIGRATION_FILES],
      ['git', 'checkout', 'main'],
      ['git', 'branch', '-D', MIGRATION_BRANCH],
    ]);
  });

  test('never runs a blanket clean or `add -A`, which could delete unrelated files', () => {
    const exec = fakeExec();
    rollbackMigration('/repo', 'main', exec);

    const clean = exec.calls.find((c) => c[1] === 'clean');
    assert.ok(clean.includes('--'), 'clean must be limited to explicit paths');
    assert.equal(exec.calls.some((c) => c.includes('-A')), false);
    assert.equal(exec.calls.some((c) => c.includes('-x') || c.includes('-fdx')), false);
  });

  test('propagates a failure so the caller can print manual cleanup steps', () => {
    const exec = fakeExec({ 'git checkout main': new Error('checkout failed') });
    assert.throws(() => rollbackMigration('/repo', 'main', exec), /checkout failed/);
  });
});

function tempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hookify-migrate-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('usedOrganizeImports', () => {
  test('true when the plugin is listed in a Prettier config file', () => {
    const dir = tempProject({ '.prettierrc': '{"plugins":["prettier-plugin-organize-imports"]}' });
    assert.equal(usedOrganizeImports(dir), true);
  });

  test('true when it is listed under the "prettier" key of package.json', () => {
    const dir = tempProject({
      'package.json': { prettier: { plugins: ['prettier-plugin-organize-imports'] } },
    });
    assert.equal(usedOrganizeImports(dir), true);
  });

  test('false when the plugin is only a devDependency, not enabled in the config', () => {
    // Prettier 3 only loads plugins named in its config.
    const dir = tempProject({
      'package.json': { devDependencies: { 'prettier-plugin-organize-imports': '^4.0.0' } },
      '.prettierrc': '{"semi":true}',
    });
    assert.equal(usedOrganizeImports(dir), false);
  });

  test('false with no Prettier config at all', () => {
    assert.equal(usedOrganizeImports(tempProject()), false);
  });
});

describe('enableSortImports', () => {
  test('adds sortImports: true and keeps the other options', () => {
    const dir = tempProject({ '.oxfmtrc.json': { singleQuote: true, printWidth: 80 } });

    assert.equal(enableSortImports(dir), 'enabled');

    const config = JSON.parse(readFileSync(join(dir, '.oxfmtrc.json'), 'utf8'));
    assert.deepEqual(config, { singleQuote: true, printWidth: 80, sortImports: true });
  });

  test('never overrides an explicit choice', () => {
    const dir = tempProject({ '.oxfmtrc.json': { sortImports: false } });

    assert.equal(enableSortImports(dir), 'already-set');
    assert.equal(JSON.parse(readFileSync(join(dir, '.oxfmtrc.json'), 'utf8')).sortImports, false);
  });

  test('reports a missing config file', () => {
    assert.equal(enableSortImports(tempProject()), 'missing');
  });

  test('reports a config it cannot parse instead of clobbering it', () => {
    const dir = tempProject({ '.oxfmtrc.json': '{ // comment\n "semi": true }' });
    const before = readFileSync(join(dir, '.oxfmtrc.json'), 'utf8');

    assert.equal(enableSortImports(dir), 'unreadable');
    assert.equal(readFileSync(join(dir, '.oxfmtrc.json'), 'utf8'), before);
  });
});

describe('detectPackageManager', () => {
  test('defaults to npm with nothing to go on', () => {
    assert.equal(detectPackageManager(tempProject()), 'npm');
  });

  test('reads the lockfile', () => {
    assert.equal(detectPackageManager(tempProject({ 'pnpm-lock.yaml': '' })), 'pnpm');
    assert.equal(detectPackageManager(tempProject({ 'yarn.lock': '' })), 'yarn');
    assert.equal(detectPackageManager(tempProject({ 'bun.lockb': '' })), 'bun');
    assert.equal(detectPackageManager(tempProject({ 'package-lock.json': '{}' })), 'npm');
  });

  test('the packageManager field wins over a stray lockfile', () => {
    const dir = tempProject({
      'package.json': { packageManager: 'pnpm@9.1.0' },
      'package-lock.json': '{}',
    });
    assert.equal(detectPackageManager(dir), 'pnpm');
  });
});

describe('installCommand', () => {
  test('maps each package manager to its dev-dependency install command', () => {
    const pkgs = ['oxlint', 'oxfmt'];
    assert.deepEqual(installCommand('npm', pkgs), ['npm', ['install', '-D', 'oxlint', 'oxfmt']]);
    assert.deepEqual(installCommand('pnpm', pkgs), ['pnpm', ['add', '-D', 'oxlint', 'oxfmt']]);
    assert.deepEqual(installCommand('yarn', pkgs), ['yarn', ['add', '-D', 'oxlint', 'oxfmt']]);
    assert.deepEqual(installCommand('bun', pkgs), ['bun', ['add', '-d', 'oxlint', 'oxfmt']]);
  });
});

describe('installOxcPackages', () => {
  test('installs both packages with the detected manager', () => {
    const dir = tempProject({ 'package.json': {}, 'package-lock.json': '{}' });
    const exec = fakeExec();

    const result = installOxcPackages(dir, exec);

    assert.deepEqual(result, { installed: ['oxlint', 'oxfmt'], manager: 'npm' });
    assert.deepEqual(exec.calls, [['npm', 'install', '-D', 'oxlint', 'oxfmt']]);
  });

  test('only installs what is missing, so existing versions are not bumped', () => {
    const dir = tempProject({ 'package.json': { devDependencies: { oxlint: '^1.0.0' } } });
    const exec = fakeExec();

    const result = installOxcPackages(dir, exec);

    assert.deepEqual(result.installed, ['oxfmt']);
    assert.deepEqual(exec.calls, [['npm', 'install', '-D', 'oxfmt']]);
  });

  test('does nothing when both are already declared', () => {
    const dir = tempProject({
      'package.json': { dependencies: { oxlint: '^1.0.0' }, devDependencies: { oxfmt: '^0.7.0' } },
    });
    const exec = fakeExec();

    assert.deepEqual(installOxcPackages(dir, exec), { installed: [], manager: null });
    assert.deepEqual(exec.calls, []);
  });
});

describe('formatGeneratedConfigs', () => {
  test('formats exactly the generated config files that exist', () => {
    const dir = tempProject({ '.oxfmtrc.json': '{}', '.oxlintrc.json': '{}' });
    const exec = fakeExec();

    assert.deepEqual(formatGeneratedConfigs(dir, exec), ['.oxfmtrc.json', '.oxlintrc.json']);
    assert.deepEqual(exec.calls, [
      ['npx', '--no-install', 'oxfmt', '.oxfmtrc.json', '.oxlintrc.json'],
    ]);
  });

  test('skips the call entirely when neither file exists', () => {
    const exec = fakeExec();
    assert.deepEqual(formatGeneratedConfigs(tempProject(), exec), []);
    assert.deepEqual(exec.calls, []);
  });
});