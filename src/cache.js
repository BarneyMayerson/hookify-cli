import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CACHE_FILE = 'manifest.json';

export function cachePath(gitDir) {
  return join(gitDir, 'hookify', CACHE_FILE);
}

export function readCache(gitDir) {
  const path = cachePath(gitDir);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupted cache is equivalent to no cache at all.
    return null;
  }
}

export function writeCache(gitDir, manifest) {
  const path = cachePath(gitDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Three scenarios from the roadmap:
 *   network available                  -> fresh manifest, cache updated
 *   no network, cache exists            -> silent fail-open on the cache
 *   no network, cache never existed     -> skip checks with an explicit message
 *
 * The underlying network error is surfaced even in fail-open scenarios —
 * silently swallowing it makes it impossible to diagnose what happened
 * (e.g. an untrusted TLS certificate on a local .lan domain).
 *
 * @returns {{manifest: object|null, source: 'network'|'cache'|'none', error?: Error}}
 */
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