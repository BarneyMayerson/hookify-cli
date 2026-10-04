#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { installHook, removeManagedHook, HOOK_TYPES } from './hooks.js';
import { resolveManifest } from './cache.js';
import { resolveGitDir, repoRoot, detectMonorepo } from './repo.js';
import {
  MIGRATION_BRANCH,
  isWorkingTreeClean,
  currentBranchExists,
  createMigrationBranch,
  runEslintMigration,
  runPrettierMigration,
  diffStat,
  commitMigration,
} from './migrate.js';

const SUPPORTED_SCHEMA_VERSION = 1;
const DEFAULT_API = 'https://hookify.dev/api/v1';

const log = (msg) => console.log(`[Hookify] ${msg}`);

function readToken() {
  return process.env.HOOKIFY_TOKEN ?? null;
}

async function fetchManifest(apiBase, token) {
  const res = await fetch(`${apiBase}/manifest`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Manifest request failed: ${res.status}`);
  return res.json();
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
      // A Hookify hook used to be here — now no check is enabled for this
      // type. Remove it ourselves rather than leaving an invisible old
      // version around with checks that are already disabled in the
      // constructor.
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
 * CLI already sits where the code is. Step 1 of 2: commits to a local
 * branch and stops there. Pushing + opening the PR is a deliberate manual
 * step for now; automating that needs a GitHub-scoped token the CLI
 * doesn't currently hold, and that's a separate piece of work.
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

  log(`Creating branch ${MIGRATION_BRANCH}...`);
  createMigrationBranch(root);

  log('Running @oxlint/migrate...');
  try {
    log(runEslintMigration(root).trim());
  } catch (error) {
    log(`ESLint migration failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  log('Running oxfmt --migrate prettier...');
  try {
    log(runPrettierMigration(root).trim());
  } catch (error) {
    log(`Prettier migration failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  log('--- Changes ---');
  log(diffStat(root).trim());

  const confirmed = await askYesNo(`Commit these changes to ${MIGRATION_BRANCH}? (y/N) `);
  if (!confirmed) {
    log(
      'Not committed. Review the changes yourself, then `git add -A && git commit`, ' +
        'or `git checkout -` to discard and go back.',
    );
    return;
  }

  commitMigration(root);
  log(`Committed. Next: `);
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