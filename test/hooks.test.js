import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decideHookAction, installHook, removeManagedHook, HOOKIFY_MARKER } from '../src/hooks.js';
import { resolveManifest, writeCache } from '../src/cache.js';

const checks = [{ id: 'pint', run: 'vendor/bin/pint --dirty --test' }];

const manifest = {
  schema_version: 1,
  project: { id: 1, name: 'Acme' },
  hooks: { 'pre-commit': checks, 'commit-msg': [] },
};

function tempGitDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hookify-'));
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  return dir;
}

describe('decideHookAction', () => {
  test('creates when no hook exists', () => {
    assert.equal(decideHookAction(null), 'create');
  });

  test('overwrites its own hook without backup spam', () => {
    assert.equal(decideHookAction(`#!/bin/sh\n${HOOKIFY_MARKER}\n`), 'overwrite');
  });

  test('backs up a foreign hook', () => {
    assert.equal(decideHookAction('#!/bin/sh\nnpx husky\n'), 'backup-and-replace');
  });
});

describe('installHook', () => {
  test('never destroys a foreign hook', () => {
    const gitDir = tempGitDir();
    const original = '#!/bin/sh\nnpx husky run pre-commit\n';
    writeFileSync(join(gitDir, 'hooks', 'pre-commit'), original);

    const { action, backupPath } = installHook(gitDir, 'pre-commit', 'Acme', checks);

    assert.equal(action, 'backup-and-replace');
    assert.equal(readFileSync(backupPath, 'utf8'), original);
    assert.match(readFileSync(join(gitDir, 'hooks', 'pre-commit'), 'utf8'), /Hookify/);
  });

  test('does not pile up backups on repeated sync', () => {
    const gitDir = tempGitDir();

    installHook(gitDir, 'pre-commit', 'Acme', checks);
    installHook(gitDir, 'pre-commit', 'Acme', checks);
    installHook(gitDir, 'pre-commit', 'Acme', checks);

    const backups = readdirSync(join(gitDir, 'hooks')).filter((f) => f.includes('.backup.'));
    assert.equal(backups.length, 0);
  });

  test('writes an executable hook', () => {
    const gitDir = tempGitDir();
    installHook(gitDir, 'pre-commit', 'Acme', checks);

    const content = readFileSync(join(gitDir, 'hooks', 'pre-commit'), 'utf8');
    assert.match(content, /^#!\/bin\/sh/);
    assert.match(content, /vendor\/bin\/pint --dirty --test/);
  });

  test('installs a commit-msg hook independently of pre-commit', () => {
    const gitDir = tempGitDir();
    const commitMsgChecks = [{ id: 'commitlint', run: 'npx --no-install commitlint --edit "$1"' }];

    installHook(gitDir, 'commit-msg', 'Acme', commitMsgChecks);

    const content = readFileSync(join(gitDir, 'hooks', 'commit-msg'), 'utf8');
    assert.match(content, /commitlint --edit "\$1"/);
    // Соседний pre-commit не должен появиться как побочный эффект.
    assert.equal(readdirSync(join(gitDir, 'hooks')).includes('pre-commit'), false);
  });
});

describe('removeManagedHook', () => {
  test('removes a hook it previously installed', () => {
    const gitDir = tempGitDir();
    installHook(gitDir, 'commit-msg', 'Acme', [{ id: 'commitlint', run: 'commitlint --edit "$1"' }]);

    const removed = removeManagedHook(gitDir, 'commit-msg');

    assert.equal(removed, true);
    assert.equal(existsSync(join(gitDir, 'hooks', 'commit-msg')), false);
  });

  test('does nothing when no hook file exists', () => {
    const gitDir = tempGitDir();

    assert.equal(removeManagedHook(gitDir, 'commit-msg'), false);
  });

  test('never removes a foreign hook without the Hookify marker', () => {
    const gitDir = tempGitDir();
    const original = '#!/bin/sh\nnpx husky\n';
    writeFileSync(join(gitDir, 'hooks', 'commit-msg'), original);

    const removed = removeManagedHook(gitDir, 'commit-msg');

    assert.equal(removed, false);
    assert.equal(readFileSync(join(gitDir, 'hooks', 'commit-msg'), 'utf8'), original);
  });
});

describe('resolveManifest', () => {
  test('uses the network when available', async () => {
    const gitDir = tempGitDir();
    const result = await resolveManifest(gitDir, async () => manifest);

    assert.equal(result.source, 'network');
  });

  test('falls back to cache when offline', async () => {
    const gitDir = tempGitDir();
    writeCache(gitDir, manifest);

    const result = await resolveManifest(gitDir, async () => {
      throw new Error('offline');
    });

    assert.equal(result.source, 'cache');
    assert.equal(result.manifest.project.name, 'Acme');
  });

  test('reports none on first run with no network and no cache', async () => {
    const gitDir = tempGitDir();

    const result = await resolveManifest(gitDir, async () => {
      throw new Error('offline');
    });

    assert.equal(result.source, 'none');
    assert.equal(result.manifest, null);
  });

  test('surfaces the underlying error instead of swallowing it', async () => {
    const gitDir = tempGitDir();

    const result = await resolveManifest(gitDir, async () => {
      throw new Error('unable to verify the first certificate');
    });

    assert.equal(result.error?.message, 'unable to verify the first certificate');
  });
});