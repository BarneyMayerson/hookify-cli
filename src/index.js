#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { installHook, removeManagedHook, clearManagedHooks, HOOK_TYPES } from './hooks.js';
import { resolveManifest, clearCache } from './cache.js';
import { resolveGitDir, repoRoot, detectMonorepo } from './repo.js';
import { fetchManifest, UnauthorizedError } from './api.js';
import {
  MIGRATION_BRANCH,
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
} from './migrate.js';

const SUPPORTED_SCHEMA_VERSION = 1;
const DEFAULT_API = 'https://hookify.dev/api/v1';

const log = (msg) => console.log(`[Hookify] ${msg}`);

function readToken() {
  return process.env.HOOKIFY_TOKEN ?? null;
}

async function sync() {
  const gitDir = resolveGitDir();
  const root = repoRoot();

  if (!gitDir || !root) {
    log('Not a git repository. Run this inside your project.');
    process.exitCode = 1;
    return;
  }

  const nested = detectMonorepo(root);
  if (nested.length > 0) {
    log(`Monorepo detected (${nested.length} nested manifests) — not supported yet.`);
    log('v1.0 assumes a single root composer.json/package.json. See roadmap.');
    process.exitCode = 1;
    return;
  }

  const token = readToken();
  if (!token) {
    log('Missing HOOKIFY_TOKEN. Get it from your project page.');
    process.exitCode = 1;
    return;
  }

  const apiBase = process.env.HOOKIFY_API ?? DEFAULT_API;
  const { manifest, source, error } = await resolveManifest(gitDir, () =>
    fetchManifest(apiBase, token),
  );

  // A dead token (revoked or the project was deleted) is categorically
  // different from "can't reach the server right now": falling back to
  // cache would mean silently running stale checks forever for a project
  // that no longer exists. Instead: stop managing it, tell the user why.
  if (error instanceof UnauthorizedError) {
    log('This project token is no longer valid — it may have been revoked or the project deleted.');
    const removed = clearManagedHooks(gitDir, HOOK_TYPES);
    clearCache(gitDir);
    if (removed.length > 0) {
      log(`Removed the Hookify-managed hook(s): ${removed.join(', ')}.`);
    }
    log('Get a fresh HOOKIFY_TOKEN from the project page if it still exists.');
    process.exitCode = 1;
    return;
  }

  if (source === 'none') {
    // First run with no network: no cache yet, nothing to install.
    log('First-time setup requires internet. Skipping checks.');
    if (error) log(`Reason: ${error.message}`);
    return;
  }

  if (source === 'cache' && error) {
    log(`Offline — using last cached config. Reason: ${error.message}`);
  }

  if (manifest.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    log(
      `Manifest schema v${manifest.schema_version} is not supported by this CLI ` +
        `(expects v${SUPPORTED_SCHEMA_VERSION}). Please update.`,
    );
    process.exitCode = 1;
    return;
  }

  let installedAny = false;

  for (const hookName of HOOK_TYPES) {
    const checks = manifest.hooks[hookName] ?? [];

    if (checks.length > 0) {
      installedAny = true;
      const { action, backupPath } = installHook(gitDir, hookName, manifest.project.name, checks);

      if (action === 'backup-and-replace') {
        log(`An existing ${hookName} hook was backed up to ${backupPath}`);
      }

      log(`${hookName} hook installed (${checks.length} checks).`);
    } else if (removeManagedHook(gitDir, hookName)) {
      log(`${hookName} hook removed (0 checks enabled).`);
    }
  }

  if (!installedAny) {
    log('No checks enabled for this project.');
  }
}

async function askYesNo(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Runs locally in the already-checked-out repo — no cloning needed, the
 * CLI already sits where the code is. Commits to a local branch and stops
 * there: pushing + opening the PR is a deliberate manual step for now.
 *
 * Any way out other than a confirmed commit (a failing tool, nothing
 * changed, the user declining) rolls the repository back to where it
 * started, so the command never leaves a half-finished branch behind.
 */
async function migrate() {
  const root = repoRoot();

  if (!root) {
    log('Not a git repository. Run this inside your project.');
    process.exitCode = 1;
    return;
  }

  if (!isWorkingTreeClean(root)) {
    log('Working tree has uncommitted changes. Commit or stash them before migrating.');
    process.exitCode = 1;
    return;
  }

  if (currentBranchExists(root, MIGRATION_BRANCH)) {
    log(`Branch ${MIGRATION_BRANCH} already exists. Delete it or finish that migration first.`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(join(root, 'eslint.config.js'))) {
    log('No eslint.config.js found — only the flat config format is supported for now.');
    process.exitCode = 1;
    return;
  }

  const originalRef = currentRef(root);

  const rollback = () => {
    try {
      rollbackMigration(root, originalRef);
      log(`Rolled back: back on ${originalRef}, ${MIGRATION_BRANCH} removed.`);
    } catch (error) {
      log(`Automatic rollback failed: ${error.message}`);
      log(`Clean up by hand: git reset --hard && git checkout ${originalRef} && git branch -D ${MIGRATION_BRANCH}`);
    }
  };

  log(`Creating branch ${MIGRATION_BRANCH}...`);
  createMigrationBranch(root);

  log('Running @oxlint/migrate...');
  try {
    log(runEslintMigration(root).trim());
  } catch (error) {
    log(`ESLint migration failed: ${error.message}`);
    rollback();
    process.exitCode = 1;
    return;
  }

  log('Running oxfmt --migrate prettier...');
  try {
    log(runPrettierMigration(root).trim());
  } catch (error) {
    log(`Prettier migration failed: ${error.message}`);
    rollback();
    process.exitCode = 1;
    return;
  }

  stageAll(root);
  const stat = stagedStat(root).trim();

  if (!stat) {
    log('The migration tools changed nothing — nothing to commit.');
    rollback();
    return;
  }

  log('--- Changes (staged) ---');
  log(stat);

  const confirmed = await askYesNo(`Commit these changes to ${MIGRATION_BRANCH}? (y/N) `);
  if (!confirmed) {
    log('Not committed.');
    rollback();
    return;
  }

  try {
    commitMigration(root);
  } catch {
    // Typically a pre-commit hook rejecting the commit. Keep the staged
    // work: rolling back here would throw away a finished migration.
    log(`The commit was rejected (see the output above). The changes are still staged on ${MIGRATION_BRANCH}.`);
    log('Fix the cause and run `git commit`, or `git commit --no-verify` if a hook is what blocked it.');
    process.exitCode = 1;
    return;
  }

  log('Committed. Next:');
  log(`  git push -u origin ${MIGRATION_BRANCH}`);
  log('  ...then open a pull request.');
  log('(Hookify will be able to open the PR for you automatically in a future version.)');
}

const command = process.argv[2];

if (command === 'sync') {
  await sync();
} else if (command === 'migrate') {
  await migrate();
} else {
  console.log('Usage: hookify sync | hookify migrate');
  process.exitCode = command ? 1 : 0;
}