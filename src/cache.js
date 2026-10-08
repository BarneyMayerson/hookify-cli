import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CACHE_FILE = 'manifest.json';

export function cachePath(gitDir) {
  return join(gitDir, 'hookify', CACHE_FILE);
}

/**
 * Removes a cached manifest — used when the token behind it is confirmed
 * dead (401), so a stale manifest for a now-nonexistent project doesn't
 * keep resurfacing on future offline syncs.
 */
export function clearCache(gitDir) {
  const path = cachePath(gitDir);
  if (existsSync(path)) unlinkSync(path);
}

export function readCache(gitDir) {
  const path = cachePath(gitDir);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCache(gitDir, manifest) {
  const path = cachePath(gitDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
}

export async function resolveManifest(gitDir, fetchManifest) {
  try {
    const manifest = await fetchManifest();
    writeCache(gitDir, manifest);
    return { manifest, source: 'network' };
  } catch (error) {
    const cached = readCache(gitDir);
    return cached
      ? { manifest: cached, source: 'cache', error }
      : { manifest: null, source: 'none', error };
  }
}