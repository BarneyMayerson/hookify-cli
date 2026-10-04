import { execFileSync } from 'node:child_process';

export const MIGRATION_BRANCH = 'hookify/migrate-to-oxc';

/**
 * Every function here takes an injectable `exec` (defaults to
 * execFileSync) so the orchestration logic can be unit-tested without
 * actually invoking git/npx — mirrors the fetchManifest-injection pattern
 * already used in cache.js.
 */

export function isWorkingTreeClean(cwd, exec = execFileSync) {
  const output = exec('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  return output.trim().length === 0;
}

export function currentBranchExists(cwd, branch, exec = execFileSync) {
  try {
    exec('git', ['rev-parse', '--verify', branch], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function createMigrationBranch(cwd, exec = execFileSync) {
  exec('git', ['checkout', '-b', MIGRATION_BRANCH], { cwd, encoding: 'utf8' });
}

// --yes on the npx calls only auto-confirms installing the migration
// tool itself if it isn't cached locally — the separate commit
// confirmation below is a distinct prompt, not skipped by this.
export function runEslintMigration(cwd, exec = execFileSync) {
  return exec('npx', ['--yes', '@oxlint/migrate', 'eslint.config.js'], { cwd, encoding: 'utf8' });
}

export function runPrettierMigration(cwd, exec = execFileSync) {
  return exec('npx', ['--yes', 'oxfmt@latest', '--migrate', 'prettier'], { cwd, encoding: 'utf8' });
}

export function diffStat(cwd, exec = execFileSync) {
  return exec('git', ['diff', '--stat'], { cwd, encoding: 'utf8' });
}

export function commitMigration(cwd, exec = execFileSync) {
  exec('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  exec(
    'git',
    ['commit', '-m', 'chore: migrate ESLint + Prettier config to OXC (oxlint/oxfmt)'],
    { cwd, encoding: 'utf8' },
  );
}