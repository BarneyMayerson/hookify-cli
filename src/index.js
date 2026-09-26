#!/usr/bin/env node
import { installHook, removeManagedHook, HOOK_TYPES } from './hooks.js';
import { resolveManifest } from './cache.js';
import { resolveGitDir, repoRoot, detectMonorepo } from './repo.js';

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

const command = process.argv[2];

if (command === 'sync') {
  await sync();
} else {
  console.log('Usage: hookify sync');
  process.exitCode = command ? 1 : 0;
}