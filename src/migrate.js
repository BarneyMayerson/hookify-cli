import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export const OXC_PACKAGES = ['oxlint', 'oxfmt'];

const ORGANIZE_IMPORTS_PLUGIN = 'prettier-plugin-organize-imports';

const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
];

function readPackageJson(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Did the Prettier setup sort imports with prettier-plugin-organize-imports?
 * oxfmt can't load Prettier plugins, so that behaviour silently disappears
 * in the migration — unless we turn on its built-in `sortImports`.
 *
 * Merely having the plugin in devDependencies proves nothing (Prettier 3
 * only loads plugins listed in its config), so look at the config itself.
 */
export function usedOrganizeImports(root) {
  const inConfigFile = PRETTIER_CONFIG_FILES.some((name) => {
    const path = join(root, name);
    try {
      return existsSync(path) && readFileSync(path, 'utf8').includes(ORGANIZE_IMPORTS_PLUGIN);
    } catch {
      return false;
    }
  });

  if (inConfigFile) return true;

  // The `"prettier"` key inside package.json is a valid config location too.
  return JSON.stringify(readPackageJson(root).prettier ?? '').includes(ORGANIZE_IMPORTS_PLUGIN);
}

/**
 * Turns on oxfmt's `sortImports` in the generated .oxfmtrc.json. It uses an
 * algorithm similar to eslint-plugin-perfectionist, not TypeScript's
 * organizeImports — expect some files' imports to be reordered the first
 * time oxfmt runs over the codebase.
 *
 * @returns {'enabled'|'already-set'|'missing'|'unreadable'}
 */
export function enableSortImports(root) {
  const path = join(root, '.oxfmtrc.json');
  if (!existsSync(path)) return 'missing';

  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'unreadable';
  }

  // Respect an explicit choice already present in the config.
  if (config.sortImports !== undefined) return 'already-set';

  config.sortImports = true;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return 'enabled';
}

/**
 * Which package manager owns this project? `packageManager` in
 * package.json (corepack) is authoritative; otherwise go by lockfile.
 * Installing with the wrong one would create a second, conflicting lockfile.
 */
export function detectPackageManager(root) {
  const declared = readPackageJson(root).packageManager;
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name;
  }

  const byLockfile = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, manager] of byLockfile) {
    if (existsSync(join(root, file))) return manager;
  }

  return 'npm';
}

export function installCommand(manager, packages) {
  switch (manager) {
    case 'pnpm':
      return ['pnpm', ['add', '-D', ...packages]];
    case 'yarn':
      return ['yarn', ['add', '-D', ...packages]];
    case 'bun':
      return ['bun', ['add', '-d', ...packages]];
    default:
      return ['npm', ['install', '-D', ...packages]];
  }
}

/** Packages not already declared — re-running `install -D` could bump them. */
export function missingPackages(root, names) {
  const pkg = readPackageJson(root);
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  return names.filter((name) => !(name in declared));
}

/**
 * The migration tools only write config files; without the binaries
 * installed, `npx --no-install oxlint` in a Hookify hook fails outright.
 * stdio is inherited so a slow install isn't a silent hang.
 *
 * @returns {{installed: string[], manager: string|null}}
 */
export function installOxcPackages(root, exec = execFileSync) {
  const missing = missingPackages(root, OXC_PACKAGES);
  if (missing.length === 0) return { installed: [], manager: null };

  const manager = detectPackageManager(root);
  const [cmd, args] = installCommand(manager, missing);
  exec(cmd, args, { cwd: root, stdio: 'inherit' });

  return { installed: missing, manager };
}

/**
 * The tools themselves note the generated configs "may not be formatted
 * yet", and a repo-wide `oxfmt --check .` (what the Hookify hook runs)
 * would trip on them. Format only those two files — reformatting the
 * whole codebase is a much bigger change that belongs in its own commit.
 *
 * @returns {string[]} the files that were formatted
 */
export function formatGeneratedConfigs(root, exec = execFileSync) {
  const files = ['.oxfmtrc.json', '.oxlintrc.json'].filter((f) => existsSync(join(root, f)));
  if (files.length === 0) return [];

  exec('npx', ['--no-install', 'oxfmt', ...files], { cwd: root, encoding: 'utf8' });
  return files;
}

/**
 * Everything `migrate` is allowed to create or modify — and therefore the
 * only things it ever stages or cleans up. Deliberately NOT `git add -A`:
 * that would also sweep in whatever else happens to be untracked, such as
 * node_modules in a repo whose .gitignore doesn't cover it.
 */
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];
export const MIGRATION_FILES = ['.oxlintrc.json', '.oxfmtrc.json', 'package.json', ...LOCKFILES];

function isGitIgnored(root, file, exec) {
  // `git check-ignore -q`: exit 0 = ignored, exit 1 = not ignored (execFileSync throws).
  try {
    exec('git', ['check-ignore', '-q', '--', file], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * The migration tools mostly create NEW files (.oxlintrc.json,
 * .oxfmtrc.json). `git diff --stat` ignores untracked files, so reviewing
 * with it shows nothing at all — stage first, then show what's staged:
 * that is exactly what the commit will contain. Gitignored files are
 * skipped, since `git add` refuses an explicitly named ignored path.
 *
 * @returns {string[]} the files that were staged
 */
export function stageMigrationFiles(root, exec = execFileSync) {
  const paths = MIGRATION_FILES.filter(
    (file) => existsSync(join(root, file)) && !isGitIgnored(root, file, exec),
  );

  if (paths.length > 0) exec('git', ['add', '--', ...paths], { cwd: root, encoding: 'utf8' });
  return paths;
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
 * Puts the repository back to where it was before `migrate` started.
 *
 * `migrate` refuses to run on a dirty tree (untracked files included), so
 * anything that differs from HEAD now came from the migration:
 *  - `reset --hard` restores tracked files (package.json, a lockfile) and
 *    unstages — it never touches untracked ones.
 *  - `clean -f` is limited to the named paths, which are the only files the
 *    migration can create; a blanket clean would also delete unrelated
 *    untracked files. It only removes untracked matches, so a tracked
 *    lockfile restored by the reset is safe.
 * Packages installed into node_modules stay there — harmless, and not
 * tracked by git anyway.
 */
export function rollbackMigration(cwd, originalRef, exec = execFileSync) {
  exec('git', ['reset', '--hard', 'HEAD'], { cwd, encoding: 'utf8' });
  exec('git', ['clean', '-f', '--', ...MIGRATION_FILES], { cwd, encoding: 'utf8' });
  exec('git', ['checkout', originalRef], { cwd, encoding: 'utf8' });
  exec('git', ['branch', '-D', MIGRATION_BRANCH], { cwd, encoding: 'utf8' });
}