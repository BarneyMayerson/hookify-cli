import { execFileSync } from 'node:child_process';

export const MIGRATION_BRANCH = 'hookify/migrate-to-oxc';
export const COMMIT_MESSAGE = 'chore: migrate ESLint + Prettier config to OXC (oxlint/oxfmt)';

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

/**
 * The ref to return to if the migration is abandoned. A detached HEAD
 * reports the literal "HEAD" as its name, so fall back to the commit hash.
 */
export function currentRef(cwd, exec = execFileSync) {
  const name = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (name !== 'HEAD') return name;
  return exec('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

export function createMigrationBranch(cwd, exec = execFileSync) {
  exec('git', ['checkout', '-b', MIGRATION_BRANCH], { cwd, encoding: 'utf8' });
}

// --yes on the npx calls only auto-confirms installing the migration
// tool itself if it isn't cached locally — the separate commit
// confirmation is a distinct prompt, not skipped by this.
export function runEslintMigration(cwd, exec = execFileSync) {
  return exec('npx', ['--yes', '@oxlint/migrate', 'eslint.config.js'], { cwd, encoding: 'utf8' });
}

export function runPrettierMigration(cwd, exec = execFileSync) {
  return exec('npx', ['--yes', 'oxfmt@latest', '--migrate', 'prettier'], { cwd, encoding: 'utf8' });
}

/**
 * The migration tools mostly create NEW files (.oxlintrc.json,
 * .oxfmtrc.json). `git diff --stat` ignores untracked files, so reviewing
 * with it shows nothing at all — stage first, then show what's staged:
 * that is exactly what the commit will contain.
 */
export function stageAll(cwd, exec = execFileSync) {
  exec('git', ['add', '-A'], { cwd, encoding: 'utf8' });
}

export function stagedStat(cwd, exec = execFileSync) {
  return exec('git', ['diff', '--cached', '--stat'], { cwd, encoding: 'utf8' });
}

// stdio is inherited so the output of any pre-commit hook is visible —
// a rejected commit is otherwise a silent, confusing failure.
export function commitMigration(cwd, exec = execFileSync) {
  exec('git', ['commit', '-m', COMMIT_MESSAGE], { cwd, stdio: 'inherit' });
}

/**
 * Puts the repository back exactly as it was before `migrate` started.
 * Safe because `migrate` refuses to run on a dirty tree (untracked files
 * included), so everything that differs from HEAD at this point was
 * produced by the migration. Staging first turns any new files into
 * tracked ones, which `reset --hard` then removes — the plain branch
 * switch alone would drag untracked files along to the original branch.
 */
export function rollbackMigration(cwd, originalRef, exec = execFileSync) {
  exec('git', ['add', '-A'], { cwd, encoding: 'utf8' });
  exec('git', ['reset', '--hard', 'HEAD'], { cwd, encoding: 'utf8' });
  exec('git', ['checkout', originalRef], { cwd, encoding: 'utf8' });
  exec('git', ['branch', '-D', MIGRATION_BRANCH], { cwd, encoding: 'utf8' });
}