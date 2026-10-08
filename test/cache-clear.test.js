import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearCache, writeCache, cachePath } from '../src/cache.js';

function tempGitDir() {
  return mkdtempSync(join(tmpdir(), 'hookify-'));
}

describe('clearCache', () => {
  test('removes an existing cache file', () => {
    const gitDir = tempGitDir();
    writeCache(gitDir, { schema_version: 1 });
    assert.equal(existsSync(cachePath(gitDir)), true);

    clearCache(gitDir);

    assert.equal(existsSync(cachePath(gitDir)), false);
  });

  test('does nothing when no cache file exists', () => {
    const gitDir = tempGitDir();
    assert.doesNotThrow(() => clearCache(gitDir));
  });
});